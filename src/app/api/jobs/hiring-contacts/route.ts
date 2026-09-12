import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/server';
import { fetchPage } from '@/lib/fetch-page';
import { askJson, MODEL_CLASSIFY } from '@/lib/ai/claude';
import { emailsOn, phoneOn, contactFromPosting, organisationLinks, contactsFromOrgPage } from '@/lib/hiring-contacts';
import { hasPostingContact } from '@/lib/schema-features';
import { Budget, logCost } from '@/lib/cost';
export const maxDuration = 300;

/**
 * Find who to call at the companies that are hiring.
 *
 * Nothing is invented. The model is only ever asked to copy a name, title, email or phone off a
 * page that has already been fetched, and `contactFromPosting` throws away anything that is not
 * literally on that page. A company where nobody is found stays a company where nobody is found.
 *
 * One timed pass, not a chain. The first version dispatched the next batch with a
 * fire-and-forget fetch before doing its own work; on the first real run it reported
 * "more: true" and the next batch never ran, and nine of seventeen companies had to be driven
 * by hand. A serverless function is not required to keep an un-awaited request alive after it
 * responds, so correctness cannot rest on one.
 *
 * Instead it works through every pending company until the deadline, then says how many are
 * left. Nothing is lost when it stops: contacts_checked_at is written per company, so the next
 * call resumes where this one ended. scripts/run-hiring-contacts.ts calls it until done, and a
 * cron hitting it makes progress every day without any driving at all.
 *
 *   POST { force?: boolean }
 */
const CONTACT = z.object({
  name: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
});

/** An organisation page lists several people; every one is checked against the page after. */
const PEOPLE = z.object({
  people: z.array(z.object({
    name: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
  })).default([]),
});

const STALE_DAYS = 30;
/** Leave headroom under maxDuration so the last company finishes and the answer is returned. */
const DEADLINE_MS = 230_000;

export async function POST(req: Request) {
  const db = supabaseAdmin();
  const body = await req.json().catch(() => ({}));
  const force = !!body.force;

  if (!(await hasPostingContact(db))) {
    return NextResponse.json({ error: 'Migration 0020 has not been applied yet.' }, { status: 503 });
  }

  const stale = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();

  // Companies with something open, that we have not looked at recently.
  const { data: open } = await db.from('job_posts')
    .select('company_id')
    .eq('status', 'open')
    .not('company_id', 'is', null)
    .limit(1000);
  const companyIds = [...new Set((open ?? []).map((r: any) => r.company_id))];
  if (!companyIds.length) return NextResponse.json({ done: true, reason: 'nothing open' });

  // Every pending company, not a fixed batch: how many get done is decided by the clock.
  let q = db.from('companies')
    .select('id, name, domain, careers_url, contact_page_url, switchboard, switchboard_source_url, general_email, general_email_source_url, email_pattern, contacts_checked_at, workspace_id')
    .in('id', companyIds)
    .order('contacts_checked_at', { ascending: true, nullsFirst: true });
  if (!force) q = q.or(`contacts_checked_at.is.null,contacts_checked_at.lt.${stale}`);
  const { data: pending } = await q;

  if (!pending?.length) return NextResponse.json({ done: true, remaining: 0, reason: 'every company has been checked recently' });

  const startedAt = Date.now();
  const companies: any[] = [];
  const workspaceId = pending[0].workspace_id as string;
  const budget = await Budget.open(db, workspaceId);
  const report: any[] = [];

  for (const co of pending) {
    // Stop before the platform stops us, so the report is returned rather than lost to a 504.
    if (Date.now() - startedAt > DEADLINE_MS) break;
    companies.push(co);
    const out: any = { company: co.name, postingContacts: 0, pages: 0 };
    try {
      // ---- 1. the company's own contact or careers page
      const pages = [co.contact_page_url, co.careers_url, co.domain ? `https://${co.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/contact` : null]
        .filter(Boolean) as string[];
      const patch: any = { contacts_checked_at: new Date().toISOString() };

      for (const url of [...new Set(pages)].slice(0, 2)) {
        const page = await fetchPage(url);
        if (page.status !== 'live') continue;
        out.pages++;
        const { hr, general } = emailsOn(page, co.domain);
        const phone = phoneOn(page);
        // Only ever fill a blank. A detail already on the company was confirmed once; this job
        // does not get to quietly replace it with something read off a different page.
        if (general && !co.general_email) { patch.general_email = general; patch.general_email_source_url = page.url; }
        if (hr && !co.general_email && !patch.general_email) { patch.general_email = hr; patch.general_email_source_url = page.url; }
        if (phone && !co.switchboard) { patch.switchboard = phone; patch.switchboard_source_url = page.url; }
        if (!co.contact_page_url) patch.contact_page_url = page.url;
        out.general = patch.general_email ?? co.general_email ?? null;
        out.switchboard = patch.switchboard ?? co.switchboard ?? null;
      }
      // ---- 1b. the organisation / leadership / team page, once per company
      //
      // Kept separate from the contact page because it answers a different question: the
      // contact page gives a switchboard, this one gives the person who decides whether a crew
      // is booked. Found by following the company's own navigation, never by guessing a path.
      let orgFound = 0;
      try {
        const home = co.domain ? await fetchPage(`https://${co.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`) : null;
        const orgUrls = home && home.status === 'live' ? organisationLinks(home, 2) : [];
        for (const orgUrl of orgUrls) {
          if (!budget.canAfford(0.01)) { out.stopped = 'daily budget reached'; break; }
          const page = await fetchPage(orgUrl);
          if (page.status !== 'live' || page.text.length < 200) continue;
          out.pages++;

          const read = await askJson(
            PEOPLE,
            'You copy people out of a company organisation or leadership page. For each person listed, copy the name and the job title exactly as printed, and the email or phone only if one is printed beside them. Copy nothing that is not on the page — never construct an address from a name, and never infer a title.',
            `Organisation page for ${co.name}:\n\n${page.text.slice(0, 8000)}`,
            MODEL_CLASSIFY,
            900,
          ).catch(() => null);
          budget.add(0.01);
          await logCost(db, workspaceId, 'hiring-contacts', `organisation page at ${co.name}`, 1, 0.01);

          const found = contactsFromOrgPage(page, read?.people ?? [], co.name, co.domain);
          if (!found.length) continue;

          // Stored as contacts on the company. contacts.lead_id is nullable, so a hiring-now
          // contact needs no lead invented for it to hang from.
          for (const c of found.slice(0, 4)) {
            // maybeSingle() errors when the name is already there more than once, and an error
            // reads as "not found" — so every re-run inserted another copy, and Aibel's HR
            // director ended up in the table five times. Ask for a row, not for exactly one.
            const { data: already } = await db.from('contacts')
              .select('id').eq('company_id', co.id).ilike('name', c.name!).limit(1);
            if (already?.length) continue;
            await db.from('contacts').insert({
              company_id: co.id, name: c.name, title: c.title ?? 'title not printed',
              email: c.email, email_status: c.email ? 'found' : 'unknown', email_source_url: c.email ? page.url : null,
              phone: c.phone, phone_source_url: c.phone ? page.url : null,
              source_url: page.url,
              linkedin_search_url: c.linkedinSearchUrl, google_search_url: c.googleSearchUrl,
            });
            orgFound++;
          }
          if (!co.contact_page_url && !patch.contact_page_url) patch.contact_page_url = page.url;
          if (orgFound) break;                                   // one good page is enough
        }
      } catch (e: any) {
        out.orgError = String(e?.message ?? e).slice(0, 120);
      }
      out.orgContacts = orgFound;

      await db.from('companies').update(patch).eq('id', co.id);

      // ---- 2. the contact printed on each open advert
      const { data: posts } = await db.from('job_posts')
        .select('id, source_url, contact_name')
        .eq('company_id', co.id).eq('status', 'open')
        .limit(6);

      for (const p of posts ?? []) {
        if (p.contact_name && !force) continue;
        if (!budget.canAfford(0.01)) { out.stopped = 'daily budget reached'; break; }
        const page = await fetchPage(p.source_url);
        if (page.status !== 'live') continue;

        const read = await askJson(
          CONTACT,
          'You copy contact details out of a job advert. Copy only what is literally printed on the page. If the advert names no person, return nulls — never infer a name, an address or a number from the company name or from anything else on the page.',
          `Job advert from ${co.name}:\n\n${page.text.slice(0, 6000)}`,
          MODEL_CLASSIFY,
          400,
        ).catch(() => null);
        budget.add(0.01);
        await logCost(db, workspaceId, 'hiring-contacts', `contact on a ${co.name} advert`, 1, 0.01);

        const found = contactFromPosting(page, read, co.domain);
        if (!found) continue;
        await db.from('job_posts').update({
          contact_name: found.name, contact_title: found.title,
          contact_email: found.email, contact_phone: found.phone,
        }).eq('id', p.id);
        out.postingContacts++;
      }
    } catch (e: any) {
      out.error = String(e?.message ?? e).slice(0, 160);
    }
    report.push(out);
  }

  const withOrg = report.filter((r) => (r.orgContacts ?? 0) > 0).length;
  const remaining = pending.length - companies.length;
  return NextResponse.json({
    checked: report.length,
    done: remaining === 0,
    remaining,
    tookMs: Date.now() - startedAt,
    // Reported on its own so the question "is the organisation page worth a standing check"
    // has a number behind it rather than an impression.
    organisationPage: {
      companiesChecked: report.length,
      companiesYielding: withOrg,
      contactsFound: report.reduce((n, r) => n + (r.orgContacts ?? 0), 0),
    },
    report,
  });
}
