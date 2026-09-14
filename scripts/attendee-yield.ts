/**
 * What the attendee lists give real companies: the old first-word lookup against src/lib/attendee-match.ts.
 *
 *   npx tsx --env-file=.env.local scripts/attendee-yield.ts [--relink]
 *
 * For every Hiring now company and every company behind an open won-work lead: how many show at least one
 * attendee a drawer would offer (an ops title, fromAttendeeList), how many of those are another company's people,
 * and — once 0030 is applied — which lists they came from. The old lookup is replayed in memory as Postgres ran
 * it: substring of the first word, the first 25 rows (the database gave no order; id order stands in for it).
 *
 * --relink rewrites Radar's attendee links (lead_people) on real leads with the new rule, ten per lead as Radar
 * makes them: links to another company's people are removed, missing ones added.
 */
import { createClient } from '@supabase/supabase-js';
import { attendeeMatch } from '../src/lib/attendee-match';
import { fromAttendeeList } from '../src/lib/hiring-contacts';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const relink = process.argv.includes('--relink');

(async () => {
  const { data: ws } = await db.from('workspaces').select('id').eq('name', 'RFBT Recruitment').single();
  const W = ws!.id;
  const has0030 = !(await db.from('people').select('seen_at_events').limit(1)).error;
  const people: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('people').select(`id, name, title, source, company_name${has0030 ? ', seen_at_events' : ''}`).eq('workspace_id', W).order('id').range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break; people.push(...data); if (data.length < 1000) break;
  }
  const lists = has0030 ? people.reduce((m: any, p: any) => { for (const e of p.seen_at_events ?? []) m[e] = (m[e] ?? 0) + 1; return m; }, {}) : { [people[0]?.source]: people.length };
  console.log(`people ${people.length} · by list ${JSON.stringify(lists)}`);

  const { data: posts } = await db.from('job_posts').select('company_id, companies!inner(name)').eq('status', 'open').eq('is_test', false);
  const hiring = [...new Map((posts ?? []).map((p: any) => [p.company_id, p.companies.name])).values()] as string[];
  const { data: leads } = await db.from('leads').select('id, company_id, companies!inner(name)').eq('workspace_id', W).eq('kind', 'won_work').eq('is_test', false).not('status', 'in', '("stale","not_for_us")');
  const won = [...new Map((leads ?? []).map((l: any) => [l.company_id, l.companies.name])).values()] as string[];

  const matchNew = (name: string) => people.filter((p) => attendeeMatch(name, p.company_name)).map((p) => ({ ...p, match: attendeeMatch(name, p.company_name)! }))
    .sort((a, b) => (a.match === b.match ? 0 : a.match === 'name' ? -1 : 1));
  const matchOld = (name: string) => { const w = name.split(' ')[0].toLowerCase(); return people.filter((p) => (p.company_name ?? '').toLowerCase().includes(w)).slice(0, 25); };

  const measure = (label: string, names: string[]) => {
    const r = { old: 0, oldWrong: 0, oldPeople: 0, now: 0, nowPeople: 0, byList: {} as Record<string, number> };
    const lines: string[] = [];
    for (const name of names) {
      const oldShown = fromAttendeeList(matchOld(name), name);
      const wrong = oldShown.filter((c) => { const p = people.find((x) => x.name === c.name && (x.title === c.title)); return !p || !attendeeMatch(name, p.company_name); });
      const nowAll = matchNew(name);
      const nowShown = fromAttendeeList(nowAll, name);
      if (oldShown.length) r.old++; if (wrong.length) r.oldWrong++; r.oldPeople += oldShown.length - wrong.length;
      if (nowShown.length) r.now++; r.nowPeople += nowShown.length;
      if (nowShown.length && has0030) for (const e of new Set(nowAll.filter((p) => fromAttendeeList([p], name).length).flatMap((p) => p.seen_at_events ?? []))) r.byList[e] = (r.byList[e] ?? 0) + 1;
      if (oldShown.length || nowShown.length) lines.push(`  ${name}: before ${oldShown.length}${wrong.length ? ` (${wrong.length} another company's)` : ''} · now ${nowShown.length}${nowShown.length ? ` — ${nowShown.map((c) => `${c.name}, ${c.title}`).slice(0, 2).join(' | ')}` : ''}`);
    }
    console.log(`\n${label}: ${names.length} companies`);
    console.log(`  before: attendees offered at ${r.old} (${r.oldWrong} of them showing another company's people; ${r.oldPeople} right people offered)`);
    console.log(`  now:    attendees offered at ${r.now} (${r.nowPeople} people offered, none from another company)${has0030 ? ` · companies with a person from each list: ${JSON.stringify(r.byList)}` : ''}`);
    lines.forEach((l) => console.log(l));
  };
  measure('Hiring now companies', hiring);
  measure('Companies behind open won-work leads', won);

  const { data: links } = await db.from('lead_people').select('lead_id, person_id, people(company_name), leads!inner(is_test, companies(name))');
  const real = (links ?? []).filter((l: any) => !l.leads.is_test);
  const wrongLinks = real.filter((l: any) => !attendeeMatch(l.leads.companies?.name ?? '', l.people?.company_name ?? ''));
  console.log(`\nRadar's attendee links on real leads: ${real.length}, of which another company's people: ${wrongLinks.length}`);
  if (!relink) return;

  // Keeps every link that still matches, removes only another company's people, and tops a lead up to ten.
  // The first version rebuilt each lead's ten from scratch: on 2026-09-14 it removed 70 links, 30 of them wrong and
  // 40 to the right company's people who were swapped for others at the same company.
  const { data: allLeads } = await db.from('leads').select('id, companies(name)').eq('workspace_id', W).eq('is_test', false);
  let removed = 0, added = 0, kept = 0;
  for (const l of allLeads ?? []) {
    const name = (l as any).companies?.name ?? '';
    const mine = real.filter((x: any) => x.lead_id === l.id);
    const drop = mine.filter((x: any) => !attendeeMatch(name, x.people?.company_name ?? '')).map((x: any) => x.person_id);
    const keep = mine.filter((x: any) => !drop.includes(x.person_id)).map((x: any) => x.person_id);
    const add = name ? matchNew(name).map((p) => p.id).filter((id) => !keep.includes(id)).slice(0, Math.max(0, 10 - keep.length)) : [];
    if (drop.length) {
      const { error } = await db.from('lead_people').delete().eq('lead_id', l.id).in('person_id', drop);
      if (error) throw new Error(`could not remove links on ${name}: ${error.message}`);
      removed += drop.length;
    }
    if (add.length) {
      const { error } = await db.from('lead_people').upsert(add.map((person_id) => ({ lead_id: l.id, person_id })));
      if (error) throw new Error(`could not add links on ${name}: ${error.message}`);
      added += add.length;
    }
    kept += keep.length;
  }
  const { count } = await db.from('lead_people').select('lead_id', { count: 'exact', head: true });
  console.log(`relinked: ${removed} links to another company's people removed, ${kept} kept, ${added} added · lead_people now ${count}`);
})().catch((e) => { console.error(e.message ?? e); process.exit(1); });
