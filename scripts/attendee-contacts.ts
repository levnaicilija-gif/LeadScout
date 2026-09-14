/**
 * For each attendee-list person a drawer offers, look for them by name on their company's own site.
 *
 *   npx tsx --env-file=.env.local scripts/attendee-contacts.ts [--search] [--write]
 *
 * Companies: every Hiring now company and every company behind an open won-work lead. People: the ones
 * fromAttendeeList offers there (src/lib/attendee-match.ts). Sites: the company's domain, and the domain of the
 * company row an attendee's own employer is on file as (NorSea's Klaus Iversen Grau is listed at "NorSea Denmark",
 * whose site is norsea.dk).
 *
 * Free first: the sites' sitemaps and home-page links (src/lib/person-on-site.ts). --search then runs one web search
 * per person still not found, limited to those sites and refused once the €2.00 daily cap cannot take it. A person
 * counts as found only when the page, fetched here, prints their name followed by an address on the company's
 * domain that fits their name. --write stores each as a contact on the company, with the page as the source of the
 * email and phone; a contact already on file by that name gains only what it lacks.
 */
import { createClient } from '@supabase/supabase-js';
import { attendeeMatch } from '../src/lib/attendee-match';
import { fromAttendeeList } from '../src/lib/hiring-contacts';
import { canonCompany } from '../src/lib/company-identity';
import { findPeopleOnSites, searchPagesNaming, personOnPage, type PersonOnPage } from '../src/lib/person-on-site';
import { fetchPage } from '../src/lib/fetch-page';
import { Budget } from '../src/lib/cost';
import { recordPersonContact } from '../src/lib/person-contact';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const search = process.argv.includes('--search');
const write = process.argv.includes('--write');

type Target = { id: string; name: string; domain: string | null; set: string };

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
  const { data: leads } = await db.from('leads').select('company_id, companies!inner(id, name, domain)').eq('workspace_id', W).eq('kind', 'won_work').eq('is_test', false).not('status', 'in', '("stale","not_for_us")');
  const targets = new Map<string, Target>();
  const asTarget = (c: any, set: string): Target => ({ id: c.id, name: c.name, domain: c.domain ?? null, set });
  for (const p of posts ?? []) targets.set((p as any).company_id, asTarget((p as any).companies, 'Hiring now'));
  for (const l of leads ?? []) if (!targets.has((l as any).company_id)) targets.set((l as any).company_id, asTarget((l as any).companies, 'won work'));

  const budget = await Budget.open(db);
  console.log(`spend today before this run €${budget.totalToday.toFixed(3)} of €${budget.capEur} · ${search ? 'web search allowed within the cap' : 'free discovery only (add --search)'} · ${write ? 'writing contacts' : 'dry run'}`);
  const tally = { people: 0, noSite: 0, freeFound: 0, searchFound: 0, notFound: 0, skippedCap: 0, stored: 0, updated: 0 };
  const lines: string[] = [];

  for (const t of targets.values()) {
    const matched = people.filter((p) => attendeeMatch(t.name, p.company_name)).map((p) => ({ ...p, match: attendeeMatch(t.name, p.company_name)! }));
    const offered = fromAttendeeList(matched, t.name).filter((o): o is typeof o & { name: string } => !!o.name);
    if (!offered.length) continue;
    const names = offered.map((o) => o.name);
    tally.people += names.length;
    const hosts = [...new Set([t.domain, ...matched.filter((p) => names.includes(p.name)).map((p) => domainByCanon.get(canonCompany(p.company_name)))].filter((h): h is string => !!h))];
    if (!hosts.length) { tally.noSite += names.length; lines.push(`${t.set} · ${t.name}: ${names.length} people, no company site on file`); continue; }

    const { found, sites } = await findPeopleOnSites(names, hosts, { maxPagesPerSite: 30 });
    const via = new Map<string, string>([...found.keys()].map((n) => [n, 'site pages']));
    tally.freeFound += found.size;
    if (search) {
      for (const n of names.filter((x) => !found.has(x))) {
        const s = await searchPagesNaming(n, hosts, { db, workspaceId: W, budget, label: t.name });
        if (s.skipped === 'daily cap') { tally.skippedCap++; continue; }
        for (const url of s.urls) {
          const page = await fetchPage(url);
          if (page.status !== 'live') continue;
          const hit = personOnPage({ text: page.text, url, fetchedAt: page.fetchedAt }, n, hosts);
          if (hit) { found.set(n, hit); via.set(n, 'web search'); tally.searchFound++; break; }
        }
      }
    }
    for (const o of offered) {
      const hit = found.get(o.name);
      if (!hit) { tally.notFound++; lines.push(`${t.set} · ${t.name} · ${o.name} (${o.title}): not found on ${hosts.join(', ')} [${sites.map((s) => `${s.host} ${s.via} ${s.read} read`).join('; ')}]`); continue; }
      lines.push(`${t.set} · ${t.name} · ${o.name}: FOUND via ${via.get(o.name)} — ${hit.title ?? o.title} · phone ${hit.phone ?? 'none printed'} · email ${hit.email} · ${hit.url}`);
      if (write) {
        const r = await store(t.id, t.name, hit, o.title ?? null);
        if (r === 'stored') tally.stored++;
        if (r === 'updated') tally.updated++;
      }
    }
  }
  lines.forEach((l) => console.log(l));
  const recovered = tally.freeFound + tally.searchFound;
  console.log(`\npeople offered from attendee lists: ${tally.people} · no company site on file: ${tally.noSite} · recovered a printed address: ${recovered} (site pages ${tally.freeFound}, web search ${tally.searchFound}) · not found: ${tally.notFound} · searches refused by the cap: ${tally.skippedCap}`);
  console.log(`spend today after €${budget.totalToday.toFixed(3)} of €${budget.capEur}${write ? ` · contacts stored ${tally.stored}, updated ${tally.updated}` : ''}`);
})().catch((e) => { console.error(e.message ?? e); process.exit(1); });

/** The same store the hiring-contacts job uses (src/lib/person-contact.ts). */
function store(companyId: string, companyName: string, hit: PersonOnPage, listTitle: string | null) {
  return recordPersonContact(db, companyId, companyName, hit, listTitle);
}
