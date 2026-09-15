import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/server';
import { crawlWorkspace } from '@/lib/crawl-workspace';
import { fetchPage } from '@/lib/fetch-page';
import { askJson, MODEL_CLASSIFY } from '@/lib/ai/claude';
import { contactFromPosting } from '@/lib/hiring-contacts';
import { discoverAtCompany, type QuotedPerson } from '@/lib/company-contact-discovery';
import { hasPostingContact } from '@/lib/schema-features';
import { Budget } from '@/lib/cost';
import { jobMeter } from '@/lib/ai/meter';
export const maxDuration = 300;

/**
 * Find who to call at the companies behind Hiring now and Won work.
 *
 * Nothing is invented. The model is only ever asked to copy a name, title, email or phone off a page that has already
 * been fetched, and everything it returns is checked against that page. A company where nobody is found stays a
 * company where nobody is found.
 *
 * The per-company chain — contact page, organisation page, named people on the company's own sites — is
 * `discoverAtCompany` (src/lib/company-contact-discovery.ts), one implementation for both screens. Item 21 added Won
 * work's companies: every company behind an open won-work lead, tender award or news story, and the people those
 * stories quoted, who are looked for by name to recover an address or number the article did not print.
 *
 * Once per company. `contacts_checked_at` is the cache: a company is read when it has not been read within
 * STALE_DAYS, however many leads or postings it has, and every company in the pending list is distinct. A company
 * with no site on file at all is skipped and left unstamped, so it is read the day a domain is found for it.
 *
 * One timed pass, not a chain: it works through pending companies until the deadline and says how many are left;
 * scripts/run-hiring-contacts.ts calls it until none are.
 *
 * Behind the cron secret. Until 2026-09-15 it answered any POST, so anyone could spend the day's budget on page reads.
 *
 *   POST { force?: boolean, scope?: 'all' | 'hiring' | 'wonwork' }
 */
const CONTACT = z.object({
  name: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
});

const STALE_DAYS = 30;
/** Leave headroom under maxDuration so the last company finishes and the answer is returned. */
const DEADLINE_MS = 230_000;
const OPEN_LEAD = '("stale","not_for_us")';

const authorised = (req: Request) => {
  const s = process.env.CRON_SECRET;
  return !!s && (req.headers.get('x-cron-secret') === s || req.headers.get('authorization') === `Bearer ${s}`);
};

export async function POST(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const body = await req.json().catch(() => ({}));
  const force = !!body.force;
  const scope: 'all' | 'hiring' | 'wonwork' = body.scope === 'hiring' || body.scope === 'wonwork' ? body.scope : 'all';

  if (!(await hasPostingContact(db))) {
    return NextResponse.json({ error: 'Migration 0020 has not been applied yet.' }, { status: 503 });
  }
  const workspaceId = await crawlWorkspace(db).catch((e: Error) => e);
  if (workspaceId instanceof Error) return NextResponse.json({ error: workspaceId.message }, { status: 500 });

  const stale = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();

  // Hiring now: companies with an open posting.
  const { data: open, error: openError } = scope === 'wonwork' ? { data: [] as any[], error: null } : await db.from('job_posts')
    .select('company_id').eq('status', 'open').not('company_id', 'is', null).limit(5000);
  if (openError) return NextResponse.json({ error: `open postings could not be read: ${openError.message}` }, { status: 500 });
  const hiringIds = new Set((open ?? []).map((r: any) => r.company_id as string));

  // Won work: companies behind an open lead, and the people their stories quoted.
  const { data: leads, error: leadsError } = scope === 'hiring' ? { data: [] as any[], error: null } : await db.from('leads')
    .select('id, company_id').eq('workspace_id', workspaceId).eq('kind', 'won_work').not('status', 'in', OPEN_LEAD).not('company_id', 'is', null).limit(5000);
  if (leadsError) return NextResponse.json({ error: `won-work leads could not be read: ${leadsError.message}` }, { status: 500 });
  const leadsBy = new Map<string, string[]>();
  for (const l of leads ?? []) leadsBy.set(l.company_id, [...(leadsBy.get(l.company_id) ?? []), l.id]);
  const companyOfLead = new Map((leads ?? []).map((l: any) => [l.id as string, l.company_id as string]));
  const quotedBy = new Map<string, QuotedPerson[]>();
  const leadIds = [...companyOfLead.keys()];
  for (let i = 0; i < leadIds.length; i += 100) {
    const { data, error } = await db.from('contacts').select('id, lead_id, name, email, phone').in('lead_id', leadIds.slice(i, i + 100));
    if (error) return NextResponse.json({ error: `quoted contacts could not be read: ${error.message}` }, { status: 500 });
    for (const c of data ?? []) {
      const co = companyOfLead.get(c.lead_id)!;
      quotedBy.set(co, [...(quotedBy.get(co) ?? []), { id: c.id, name: c.name, email: c.email, phone: c.phone }]);
    }
  }

  // `ids`: named companies, read whether or not a posting or lead stands on them — the Spanish companies from Industry
  // Contacts resolved on 2026-09-15 had neither, so nothing else would ever have read their sites.
  const named = Array.isArray(body.ids) ? (body.ids as unknown[]).map(String).filter((s) => /^[0-9a-f-]{36}$/i.test(s)) : [];
  const companyIds = named.length ? [...new Set(named)] : [...new Set([...hiringIds, ...leadsBy.keys()])];
  if (!companyIds.length) return NextResponse.json({ done: true, reason: 'no open postings or won-work leads' });

  // Every pending company, not a fixed batch: how many get done is decided by the clock.
  const pending: any[] = [];
  let noSite = 0;
  for (let i = 0; i < companyIds.length; i += 150) {
    let q = db.from('companies')
      .select('id, name, domain, careers_url, contact_page_url, switchboard, general_email, contacts_checked_at, workspace_id')
      .in('id', companyIds.slice(i, i + 150));
    if (!force) q = q.or(`contacts_checked_at.is.null,contacts_checked_at.lt.${stale}`);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: `companies could not be read: ${error.message}` }, { status: 500 });
    for (const c of data ?? []) {
      if (!c.domain && !c.careers_url && !c.contact_page_url) { noSite++; continue; }
      pending.push(c);
    }
  }
  pending.sort((a, b) => String(a.contacts_checked_at ?? '').localeCompare(String(b.contacts_checked_at ?? '')));
  if (!pending.length) return NextResponse.json({ done: true, remaining: 0, skippedNoSite: noSite, reason: 'every company with a site has been checked recently' });

  const startedAt = Date.now();
  const deadlineAt = startedAt + DEADLINE_MS;
  const budget = await Budget.open(db);
  const report: any[] = [];

  for (const co of pending) {
    // Stop before the platform stops us, so the report is returned rather than lost to a 504.
    if (Date.now() > deadlineAt) break;
    let out: any = { company: co.name };
    try {
      out = await discoverAtCompany(db, co, { budget, workspaceId, deadlineAt, quoted: quotedBy.get(co.id) });
      out.companyId = co.id;
      out.leads = leadsBy.get(co.id)?.length ?? 0;
      out.hiringNow = hiringIds.has(co.id);
      out.postingContacts = 0;

      // ---- 2. the contact printed on each open advert — a fact about a posting, so Hiring now companies only
      if (hiringIds.has(co.id)) {
        const { data: posts } = await db.from('job_posts').select('id, source_url, contact_name').eq('company_id', co.id).eq('status', 'open').limit(6);
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
            // Item 16: the read's real tokens, every attempt, added to the budget — it logged a flat €0.01 before.
            jobMeter(db, workspaceId, budget, 'hiring-contacts', `contact on a ${co.name} advert`),
          ).catch(() => null);
          const found = contactFromPosting(page, read, co.domain);
          if (!found) continue;
          await db.from('job_posts').update({ contact_name: found.name, contact_title: found.title, contact_email: found.email, contact_phone: found.phone }).eq('id', p.id);
          out.postingContacts++;
        }
      }
    } catch (e: any) {
      out.error = String(e?.message ?? e).slice(0, 160);
    }
    report.push(out);
  }

  const remaining = pending.length - report.length;
  const won = report.filter((r) => r.leads > 0);
  return NextResponse.json({
    checked: report.length,
    done: remaining === 0,
    remaining,
    skippedNoSite: noSite,
    tookMs: Date.now() - startedAt,
    // Reported on its own so "is the organisation page worth a standing check" has a number behind it.
    organisationPage: {
      companiesChecked: report.length,
      companiesYielding: report.filter((r) => (r.orgContacts ?? 0) > 0).length,
      contactsFound: report.reduce((n, r) => n + (r.orgContacts ?? 0), 0),
    },
    // Item 21: one read per company, however many leads stand on it.
    wonWork: {
      companiesChecked: won.length,
      leadsCovered: won.reduce((n, r) => n + r.leads, 0),
      quotedLookedFor: won.reduce((n, r) => n + (r.quoted?.lookedFor ?? 0), 0),
      quotedGained: won.reduce((n, r) => n + (r.quoted?.gained ?? 0), 0),
    },
    report,
  });
}
