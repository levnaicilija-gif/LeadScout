import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { fetchPage } from '@/lib/fetch-page';
import { askJson, MODEL_CLASSIFY } from '@/lib/ai/claude';
import { emailsOn, phoneOn, organisationLinks, contactsFromOrgPage, fromAttendeeList } from '@/lib/hiring-contacts';
import { attendeesAt } from '@/lib/attendee-match';
import { findPeopleOnSites, type PersonOnPage } from '@/lib/person-on-site';
import { recordPersonContact, addToQuotedContact } from '@/lib/person-contact';
import { logCost, type Budget } from '@/lib/cost';

/**
 * Who to call at one company, read off the company's own sites. The one implementation: the Hiring now pass (item 13)
 * and Won work (item 21) both run exactly this, once per company.
 *
 *   1  the contact or careers page — switchboard, general or HR address, only ever filling a blank;
 *   1b the organisation / leadership page, found through the site's own navigation — people with a hiring title;
 *   1c named people looked for on the company's sites: attendee-list people with an ops title (item 13), and — item 21 —
 *      the person a news story quoted, so an address or number the article did not print can be recovered. A quoted
 *      person gains only what they lack; they are never replaced, renamed or re-titled.
 *
 * The contact printed on an open advert stays in the route: it is a fact about a posting, not about the company.
 *
 * `contacts_checked_at` is the cache: the caller picks companies not checked within its window, and this stamps the
 * company when it has been read, so a company behind a tender award and a news story — or on Hiring now and in Won
 * work — is read once, not once per lead. Nothing is invented: the model only copies what is on a fetched page, and
 * contactsFromOrgPage / personOnPage throw away anything that is not.
 */
export type DiscoveryCompany = {
  id: string; name: string; domain: string | null; careers_url: string | null; contact_page_url: string | null;
  switchboard: string | null; general_email: string | null; workspace_id: string;
};
export type QuotedPerson = { id: string; name: string; email: string | null; phone: string | null };

const PEOPLE = z.object({
  people: z.array(z.object({
    name: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
  })).default([]),
});

const bareHost = (domain: string) => domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');

export async function discoverAtCompany(
  db: SupabaseClient,
  co: DiscoveryCompany,
  ctx: { budget: Budget; workspaceId: string; deadlineAt: number; quoted?: QuotedPerson[] },
) {
  const out: Record<string, any> = { company: co.name, pages: 0 };
  const patch: Record<string, unknown> = { contacts_checked_at: new Date().toISOString() };

  // ---- 1. the company's own contact or careers page
  const pages = [co.contact_page_url, co.careers_url, co.domain ? `https://${bareHost(co.domain)}/contact` : null].filter(Boolean) as string[];
  for (const url of [...new Set(pages)].slice(0, 2)) {
    const page = await fetchPage(url);
    if (page.status !== 'live') continue;
    out.pages++;
    const { hr, general } = emailsOn(page, co.domain);
    const phone = phoneOn(page);
    // Only ever fill a blank. A detail already on the company was confirmed once; this does not get to quietly
    // replace it with something read off a different page.
    if (general && !co.general_email) { patch.general_email = general; patch.general_email_source_url = page.url; }
    if (hr && !co.general_email && !patch.general_email) { patch.general_email = hr; patch.general_email_source_url = page.url; }
    if (phone && !co.switchboard) { patch.switchboard = phone; patch.switchboard_source_url = page.url; }
    if (!co.contact_page_url) patch.contact_page_url = page.url;
    out.general = patch.general_email ?? co.general_email ?? null;
    out.switchboard = patch.switchboard ?? co.switchboard ?? null;
  }

  // ---- 1b. the organisation / leadership / team page, once per company
  let orgFound = 0;
  try {
    const home = co.domain ? await fetchPage(`https://${bareHost(co.domain)}`) : null;
    const orgUrls = home && home.status === 'live' ? organisationLinks(home, 2) : [];
    for (const orgUrl of orgUrls) {
      if (!ctx.budget.canAfford(0.01)) { out.stopped = 'daily budget reached'; break; }
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
      ctx.budget.add(0.01);
      await logCost(db, ctx.workspaceId, 'hiring-contacts', `organisation page at ${co.name}`, 1, 0.01);

      const found = contactsFromOrgPage(page, read?.people ?? [], co.name, co.domain);
      for (const c of found.slice(0, 4)) {
        // Ask for a row, not exactly one: maybeSingle() errors on duplicates, reads as "not found", and every re-run
        // inserted another copy (Aibel's HR director ended up in the table five times).
        const { data: already } = await db.from('contacts').select('id').eq('company_id', co.id).ilike('name', c.name!).limit(1);
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

  // ---- 1c. named people looked for on the company's own sites — attendee-list people and quoted people, one crawl
  //
  // Free pages only here (sitemap, home-page links); the metered web search runs from scripts/attendee-contacts.ts,
  // under the daily cap. A quoted person who is also on the attendee list is the quoted contact: they gain the address.
  try {
    if (Date.now() < ctx.deadlineAt - 60_000) {
      const { people, error: peopleError } = await attendeesAt(db, co.workspace_id, co.name, 100);
      if (peopleError) throw new Error(`attendee list: ${peopleError}`);
      const offered = fromAttendeeList(people, co.name).map((o) => o.name).filter((n): n is string => !!n);
      const quoted = (ctx.quoted ?? []).filter((q) => !q.email || !q.phone);
      const names = [...new Set([...quoted.map((q) => q.name), ...offered])];
      if (names.length) {
        // An attendee listed at "NorSea Denmark" is looked for on that company's site too, when it is on file.
        const theirs = [...new Set(people.filter((p) => offered.includes(p.name)).map((p) => p.company_name))];
        const { data: rows } = theirs.length
          ? await db.from('companies').select('domain').eq('workspace_id', co.workspace_id).in('name', theirs).not('domain', 'is', null)
          : { data: [] as any[] };
        const hosts = [co.domain, ...(rows ?? []).map((r: any) => r.domain)].filter((h): h is string => !!h);
        const { found } = hosts.length ? await findPeopleOnSites(names, hosts, { maxPagesPerSite: 15 }) : { found: new Map<string, PersonOnPage>() };
        let kept = 0, quotedGained = 0;
        for (const hit of found.values()) {
          const q = quoted.find((x) => x.name.toLowerCase() === hit.name.toLowerCase());
          if (q) {
            if ((await addToQuotedContact(db, q.id, co.name, hit)) === 'updated') quotedGained++;
            continue;
          }
          const listTitle = people.find((p) => p.name === hit.name)?.title ?? null;
          if ((await recordPersonContact(db, co.id, co.name, hit, listTitle)) !== 'unchanged') kept++;
        }
        out.attendeesOnSite = { offered: offered.length, sites: hosts, found: found.size, kept };
        if (quoted.length) out.quoted = { lookedFor: quoted.length, gained: quotedGained };
      }
    }
  } catch (e: any) {
    out.attendeeSiteError = String(e?.message ?? e).slice(0, 120);
  }

  const { error } = await db.from('companies').update(patch).eq('id', co.id);
  if (error) out.error = `the company could not be stamped as read: ${error.message}`;
  return out;
}
