/**
 * Proves item 14's rules on the two named examples and a set of timelines. Reads two stored
 * articles (SELECT only); writes nothing.
 *
 *   npx tsx --env-file=.env.local scripts/radar-filter-check.ts
 *
 * Exits 1 on any failure.
 */
import { createClient } from '@supabase/supabase-js';
import { evaluateNews, timeline, REJECT_MONTHS } from '../src/lib/radar-filter';
import { quotedInText, companyAliases, excludedRole } from '../src/lib/quoted-contacts';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

async function lead(id: string) {
  const { data, error } = await db.from('leads')
    .select('project_name, project_location, companies(name, domain), contacts(name, title), lead_articles(articles(url, title, text, published_at, fetched_at))')
    .eq('id', id).single();
  if (error || !data) throw new Error(`could not read lead ${id}: ${error?.message}`);
  const a: any = (data as any).lead_articles[0].articles;
  return { data: data as any, a };
}

(async () => {
  console.log('Nadara / Bellrock Floating Wind Farm (EIA scoping request, construction "early 2030s"):');
  {
    const { data, a } = await lead('5324198d-3df2-400c-95f9-95db88c2f7bf');
    const people = [...quotedInText(a.text), ...(data.contacts ?? [])];
    const v = evaluateNews({ title: a.title, text: a.text, url: a.url, companyName: data.companies.name, companyDomain: data.companies.domain, project: { name: data.project_name, location: data.project_location }, people, articleDate: new Date(a.published_at ?? a.fetched_at), targets: new Set() });
    const ids = v.rules.map((r) => r.id);
    check(v.verdict === 'rejected', 'rejected', v.reason);
    check(ids.includes('excluded_trigger'), 'rule: excluded_trigger', v.rules.find((r) => r.id === 'excluded_trigger')?.evidence ?? '');
    check(ids.includes('years_out'), 'rule: years_out', v.rules.find((r) => r.id === 'years_out')?.why ?? JSON.stringify(timeline(a.text, new Date(a.published_at ?? a.fetched_at))));
    const mc = v.contacts.excluded.find((x) => /McGrellis/.test(x.name));
    check(!!mc && mc.rule === 'rep_excluded_role', 'Brian McGrellis, "Head of Consents and Land", excluded by role', mc?.why ?? JSON.stringify(v.contacts));
  }

  console.log('\nDWT / Riffgat maintenance contract (Olsen for DWT, Bolduan for EWE):');
  {
    const { data, a } = await lead('9fb3d5b1-25ee-4022-9086-7369e3137d7f');
    const people = [...quotedInText(a.text), ...(data.contacts ?? [])];
    check(people.some((p) => /Bolduan/.test(p.name)) && people.some((p) => /Olsen/.test(p.name)), 'both quoted people are read from the stored article', people.map((p) => `${p.name} (${p.title})`).join('; '));
    check(companyAliases(data.companies.name, data.companies.domain).includes('dwt'), 'aliases of "DWT (Deutsche Windtechnik)" include "dwt"', companyAliases(data.companies.name, data.companies.domain).join(' | '));
    const v = evaluateNews({ title: a.title, text: a.text, url: a.url, companyName: data.companies.name, companyDomain: data.companies.domain, project: { name: data.project_name, location: data.project_location }, people, articleDate: new Date(a.published_at ?? a.fetched_at), targets: new Set() });
    check(v.verdict === 'lead', 'stays a lead', `${v.verdict}: ${v.reason}`);
    check(v.contacts.primary?.name === 'Achim Berge Olsen', 'Achim Berge Olsen is the contact', v.contacts.primary?.why ?? 'no primary');
    const b = v.contacts.excluded.find((x) => /Bolduan/.test(x.name));
    check(!!b && b.rule === 'rep_other_company' && /EWE/.test(b.why), 'Jantje Bolduan excluded as a representative of EWE, not DWT', b?.why ?? JSON.stringify(v.contacts.excluded));
  }

  console.log('\ntimelines (article dated 2026-09-10):');
  const at = new Date('2026-09-10');
  const months = (s: string) => timeline(s, at)?.months ?? null;
  check(months('Deployment is scheduled to begin in 2027 across the array.') === 4, '"deployment scheduled to begin in 2027" is 4 months out, a lead', String(months('Deployment is scheduled to begin in 2027 across the array.')));
  check(months('Offshore construction is planned to start in the early 2030s.')! > REJECT_MONTHS, '"construction … early 2030s" is beyond 18 months');
  check(months('The project has already started with planned delivery in 2030.') === null, '"has already started … delivery in 2030" is not a future start');
  check(months('The plant is scheduled to begin operations in late 2029.') === null, '"begin operations in late 2029" is operations, not a start of work');
  check(months('The rig will be busy until 2031 under the contract.') === null, '"busy until 2031" is not a start');
  const mid = months('Fabrication is due to start in Q1 2028 at the yard.');
  check(mid === 16, '"fabrication due to start in Q1 2028" is 16 months: low confidence, not rejected', String(mid));

  console.log('\nroles:');
  check(!!excludedRole('Head of Consents and Land for the Bellrock project'), 'consents and land is not a hiring contact');
  check(!excludedRole('CEO of DWT\'s offshore division'), 'a divisional CEO is not excluded by role');
  check(!!excludedRole('Senior Analyst, Rystad Energy'), 'an analyst is excluded');
  check(!excludedRole('Project Manager, Netherlands'), '"Netherlands" does not trip the "land" rule');

  console.log(failures === 0 ? '\nradar filter: all checks passed' : `\nradar filter: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
