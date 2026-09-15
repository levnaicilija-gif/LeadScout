/**
 * Named people looked for on their company's own site: attendee-list people a drawer offers, and — item 21 — the people
 * news stories quoted, whose address or number the article did not print.
 *
 *   npx tsx --env-file=.env.local scripts/attendee-contacts.ts [--search] [--write] [--quoted-only]
 *
 * Companies: every Hiring now company and every company behind an open won-work lead. People: the ones
 * fromAttendeeList offers there (src/lib/attendee-match.ts), and the contacts on those companies' news leads that lack an
 * email or phone. Sites: the company's domain, and the domain of the company row an attendee's own employer is on file
 * as (NorSea's Klaus Iversen Grau is listed at "NorSea Denmark", whose site is norsea.dk).
 *
 * Free first: the sites' sitemaps and home-page links (src/lib/person-on-site.ts). --search then runs one web search
 * per person still not found, limited to those sites and refused once the €2.00 daily cap cannot take it — the only
 * paid path, never a background job. A person counts as found only when the page, fetched here, prints their name
 * followed by an address on the company's domain that fits their name. --write stores each attendee as a contact on
 * the company (a contact already on file by that name gains only what it lacks), and gives a quoted person only the
 * address or number they lack — never replacing them (src/lib/person-contact.ts).
 */
import { createClient } from '@supabase/supabase-js';
import { attendeeMatch } from '../src/lib/attendee-match';
import { fromAttendeeList } from '../src/lib/hiring-contacts';
import { canonCompany } from '../src/lib/company-identity';
import { findPeopleOnSites, searchPagesNaming, personOnPage } from '../src/lib/person-on-site';
import { fetchPage } from '../src/lib/fetch-page';
import { Budget } from '../src/lib/cost';
import { recordPersonContact, addToQuotedContact } from '../src/lib/person-contact';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const search = process.argv.includes('--search');
const write = process.argv.includes('--write');
const quotedOnly = process.argv.includes('--quoted-only');
/** Item 21: only companies behind an open won-work lead, so a measured run spends nothing on Hiring now's people. */
const wonWorkOnly = process.argv.includes('--won-work');

type Target = { id: string; name: string; domain: string | null; set: string };
type Quoted = { id: string; name: string; email: string | null; phone: string | null };

(async () => {
  const { data: ws } = await db.from('workspaces').select('id').eq('name', 'RFBT Recruitment').single();
  const W = ws!.id as string;
  const people: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('people').select('name, title, source, company_name').eq('workspace_id', W).order('id').range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break; people.push(...data); if (data.length < 1000) break;
  }
  const domainByCanon = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('companies').select('name, domain').eq('workspace_id', W).not('domain', 'is', null).range(from, from + 999);
    if (!data?.length) break;
    for (const c of data) if (c.domain && !domainByCanon.has(canonCompany(c.name))) domainByCanon.set(canonCompany(c.name), c.domain);
    if (data.length < 1000) break;
  }
  const { data: posts } = await db.from('job_posts').select('company_id, companies!inner(id, name, domain)').eq('status', 'open').eq('is_test', false);
  const { data: leads } = await db.from('leads').select('id, company_id, companies!inner(id, name, domain)').eq('workspace_id', W).eq('kind', 'won_work').eq('is_test', false).not('status', 'in', '("stale","not_for_us")');
  const targets = new Map<string, Target>();
  const asTarget = (c: any, set: string): Target => ({ id: c.id, name: c.name, domain: c.domain ?? null, set });
  if (!wonWorkOnly) for (const p of posts ?? []) targets.set((p as any).company_id, asTarget((p as any).companies, 'Hiring now'));
  for (const l of leads ?? []) if (!targets.has((l as any).company_id)) targets.set((l as any).company_id, asTarget((l as any).companies, 'won work'));

  // Item 21: the people news stories quoted, still without an email or a phone.
  const quotedBy = new Map<string, Quoted[]>();
  const leadIds = (leads ?? []).map((l: any) => l.id);
  const companyOfLead = new Map((leads ?? []).map((l: any) => [l.id, l.company_id]));
  for (let i = 0; i < leadIds.length; i += 100) {
    const { data, error } = await db.from('contacts').select('id, lead_id, name, email, phone').in('lead_id', leadIds.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const c of data ?? []) {
      if (c.email && c.phone) continue;
      const co = companyOfLead.get(c.lead_id)!;
      quotedBy.set(co, [...(quotedBy.get(co) ?? []), { id: c.id, name: c.name, email: c.email, phone: c.phone }]);
    }
  }

  const budget = await Budget.open(db);
  const spentBefore = budget.totalToday;
  console.log(`spend today before this run €${budget.totalToday.toFixed(3)} of €${budget.capEur} · ${search ? 'web search allowed within the cap' : 'free discovery only (add --search)'} · ${write ? 'writing contacts' : 'dry run'}${quotedOnly ? ' · quoted people only' : ''}`);
  const tally = { people: 0, noSite: 0, freeFound: 0, searchFound: 0, notFound: 0, skippedCap: 0, stored: 0, updated: 0, searches: 0 };
  const q = { lookedFor: 0, noSite: 0, freeFound: 0, searchFound: 0, notFound: 0, gained: 0 };
  const lines: string[] = [];

  for (const t of targets.values()) {
    const matched = quotedOnly ? [] : people.filter((p) => attendeeMatch(t.name, p.company_name)).map((p) => ({ ...p, match: attendeeMatch(t.name, p.company_name)! }));
    const offered = fromAttendeeList(matched, t.name).filter((o): o is typeof o & { name: string } => !!o.name);
    const quoted = quotedBy.get(t.id) ?? [];
    if (!offered.length && !quoted.length) continue;
    const isQuoted = (n: string) => quoted.some((x) => x.name.toLowerCase() === n.toLowerCase());
    const names = [...new Set([...quoted.map((x) => x.name), ...offered.map((o) => o.name)])];
    tally.people += offered.filter((o) => !isQuoted(o.name)).length;
    q.lookedFor += quoted.length;
    const hosts = [...new Set([t.domain, ...matched.filter((p) => names.includes(p.name)).map((p) => domainByCanon.get(canonCompany(p.company_name)))].filter((h): h is string => !!h))];
    if (!hosts.length) {
      tally.noSite += offered.filter((o) => !isQuoted(o.name)).length; q.noSite += quoted.length;
      lines.push(`${t.set} · ${t.name}: ${names.length} people, no company site on file`); continue;
    }

    const { found, sites } = await findPeopleOnSites(names, hosts, { maxPagesPerSite: 30 });
    const via = new Map<string, string>([...found.keys()].map((n) => [n, 'site pages']));
    for (const n of found.keys()) { if (isQuoted(n)) q.freeFound++; else tally.freeFound++; }
    if (search) {
      for (const n of names.filter((x) => !found.has(x))) {
        const s = await searchPagesNaming(n, hosts, { db, workspaceId: W, budget, label: t.name });
        if (s.skipped === 'daily cap') { tally.skippedCap++; continue; }
        if (s.eur > 0) tally.searches++;
        for (const url of s.urls) {
          const page = await fetchPage(url);
          if (page.status !== 'live') continue;
          const hit = personOnPage({ text: page.text, url, fetchedAt: page.fetchedAt }, n, hosts);
          if (hit) { found.set(n, hit); via.set(n, 'web search'); if (isQuoted(n)) q.searchFound++; else tally.searchFound++; break; }
        }
      }
    }
    for (const n of names) {
      const hit = found.get(n);
      const quotedRow = quoted.find((x) => x.name.toLowerCase() === n.toLowerCase());
      const role = quotedRow ? 'quoted' : `(${offered.find((o) => o.name === n)?.title ?? ''})`;
      if (!hit) { if (quotedRow) q.notFound++; else tally.notFound++; lines.push(`${t.set} · ${t.name} · ${n} ${role}: not found on ${hosts.join(', ')} [${sites.map((s) => `${s.host} ${s.via} ${s.read} read`).join('; ')}]`); continue; }
      lines.push(`${t.set} · ${t.name} · ${n} ${role}: FOUND via ${via.get(n)} — ${hit.title ?? ''} · phone ${hit.phone ?? 'none printed'} · email ${hit.email} · ${hit.url}`);
      if (!write) continue;
      if (quotedRow) { if ((await addToQuotedContact(db, quotedRow.id, t.name, hit)) === 'updated') q.gained++; continue; }
      const r = await recordPersonContact(db, t.id, t.name, hit, offered.find((o) => o.name === n)?.title ?? null);
      if (r === 'stored') tally.stored++;
      if (r === 'updated') tally.updated++;
    }
  }
  lines.forEach((l) => console.log(l));
  console.log(`\nattendee-list people offered: ${tally.people} · no company site on file: ${tally.noSite} · recovered a printed address: ${tally.freeFound + tally.searchFound} (site pages ${tally.freeFound}, web search ${tally.searchFound}) · not found: ${tally.notFound}`);
  console.log(`quoted people without an email or phone: ${q.lookedFor} · no company site on file: ${q.noSite} · found on their site: ${q.freeFound + q.searchFound} (site pages ${q.freeFound}, web search ${q.searchFound}) · not found: ${q.notFound}${write ? ` · gained a detail: ${q.gained}` : ''}`);
  console.log(`web searches run: ${tally.searches} · refused by the cap: ${tally.skippedCap} · this run spent €${(budget.totalToday - spentBefore).toFixed(4)} · spend today after €${budget.totalToday.toFixed(3)} of €${budget.capEur}${write ? ` · attendee contacts stored ${tally.stored}, updated ${tally.updated}` : ''}`);
})().catch((e) => { console.error(e.message ?? e); process.exit(1); });
