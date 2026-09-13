/**
 * Queue item 14, step 5: which leads the stricter filter would hide, and why. Read-only.
 *
 *   npx tsx --env-file=.env.local scripts/radar-filter-report.ts
 *
 * Re-evaluates every news-sourced won-work lead from its stored article text — no refetch, no
 * model call — under src/lib/radar-filter.ts. The people it judges are the lead's stored contacts
 * plus anyone the stored text quotes as "said Name, Title" / "Name, Title, said", so a client-side
 * quote the old extraction never kept (Bolduan at DWT) is judged too.
 *
 * Award-notice leads are listed as not evaluated: they quote nobody by design. Probe rows
 * (is_test, example.invalid) are skipped. No status is changed — the owner sets statuses.
 *
 * Exits 1 unless the two named examples come out as the owner stated: Nadara/Bellrock rejected,
 * DWT/Riffgat kept with Achim Berge Olsen and Jantje Bolduan excluded.
 */
import { createClient } from '@supabase/supabase-js';
import { evaluateNews, RULES_VERSION, LOW_CONFIDENCE_MONTHS, REJECT_MONTHS, type Verdict } from '../src/lib/radar-filter';
import { quotedInText } from '../src/lib/quoted-contacts';
import { leadSource } from '../src/lib/lead-source';
import { canonCompany } from '../src/lib/company-identity';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const NADARA = '5324198d-3df2-400c-95f9-95db88c2f7bf';
const DWT = '9fb3d5b1-25ee-4022-9086-7369e3137d7f';
const ACTIVE = ['pursue', 'contacted', 'replied', 'call', 'trial', 'framework'];

(async () => {
  // Target accounts, narrow as decided: an active lead, or pursued hiring.
  const { data: active } = await db.from('leads').select('companies(name)').in('status', ACTIVE);
  const { data: pursued } = await db.from('companies').select('name').eq('hiring_status', 'pursued');
  const targets = new Set<string>([...(active ?? []).map((l: any) => l.companies?.name), ...(pursued ?? []).map((c: any) => c.name)].filter(Boolean).map((n) => canonCompany(n)));

  const { data: leads, error } = await db.from('leads')
    .select('id, status, project_name, project_location, source_url, is_test, companies(name, domain), contacts(name, title), lead_articles(articles(url, title, text, published_at, fetched_at))')
    .eq('kind', 'won_work').eq('is_test', false);
  if (error) { console.error(error.message); process.exit(1); }

  const news = (leads ?? []).filter((l: any) => leadSource(l.source_url) === 'news' && !String(l.source_url ?? '').includes('example.invalid'));
  const tenders = (leads ?? []).length - news.length;
  console.log(`rules ${RULES_VERSION} · low confidence beyond ${LOW_CONFIDENCE_MONTHS} months, rejected beyond ${REJECT_MONTHS} · target accounts: ${targets.size} (${[...targets].join(', ') || 'none'})`);
  console.log(`news-sourced leads evaluated: ${news.length} · award-notice leads not evaluated (they quote nobody by design): ${tenders}\n`);

  const surfaced = (l: any) => !['stale', 'not_for_us'].includes(l.status);
  const results: { l: any; v: Verdict }[] = [];
  for (const l of news) {
    const a = (l.lead_articles ?? []).map((x: any) => x.articles).find((x: any) => x && String(l.source_url).startsWith(x.url)) ?? l.lead_articles?.[0]?.articles;
    if (!a?.text) { console.log(`  (no stored article text for ${(l.companies as any)?.name} — skipped)`); continue; }
    const people = [...quotedInText(a.text), ...(l.contacts ?? [])];
    const v = evaluateNews({
      title: a.title ?? '', text: a.text, url: a.url, companyName: (l.companies as any)?.name ?? '', companyDomain: (l.companies as any)?.domain,
      project: { name: l.project_name, location: l.project_location }, people,
      articleDate: new Date(a.published_at ?? a.fetched_at), targets,
    });
    results.push({ l, v });
  }

  const block = (title: string, rows: typeof results) => {
    console.log(`\n=== ${title}: ${rows.length}`);
    for (const { l, v } of rows) {
      console.log(`\n${l.companies?.name} — ${l.project_name}   [status ${l.status}] ${l.id}`);
      console.log(`  verdict: ${v.verdict.toUpperCase()} — ${v.reason}`);
      for (const r of v.rules) console.log(`  · ${r.id}: ${r.why}${r.evidence ? `\n      "${r.evidence.replace(/\s+/g, ' ').slice(0, 220)}"` : ''}`);
      if (v.contacts.primary) console.log(`  contact kept: ${v.contacts.primary.why}`);
      for (const x of v.contacts.excluded) console.log(`  excluded: ${x.why}`);
      for (const u of v.contacts.unverified) console.log(`  not established: ${u.why}`);
    }
  };
  const visible = results.filter((r) => surfaced(r.l));
  block('SURFACED TODAY and would now be HIDDEN (rejected)', visible.filter((r) => r.v.verdict === 'rejected'));
  block('SURFACED TODAY and would now be HIDDEN (low confidence)', visible.filter((r) => r.v.verdict === 'low_confidence'));
  block('SURFACED TODAY and stays', visible.filter((r) => r.v.verdict === 'lead'));
  block('already hidden by status (not_for_us / stale) — verdict for the record', results.filter((r) => !surfaced(r.l)));

  const count = (f: (r: (typeof results)[number]) => boolean) => results.filter(f).length;
  console.log(`\nTOTALS · surfaced today ${visible.length}: would be hidden ${count((r) => surfaced(r.l) && r.v.verdict !== 'lead')} (rejected ${count((r) => surfaced(r.l) && r.v.verdict === 'rejected')}, low confidence ${count((r) => surfaced(r.l) && r.v.verdict === 'low_confidence')}), stays ${count((r) => surfaced(r.l) && r.v.verdict === 'lead')} · already hidden by status ${results.length - visible.length}`);

  let failures = 0;
  const n = results.find((r) => r.l.id === NADARA);
  const d = results.find((r) => r.l.id === DWT);
  const ok1 = n?.v.verdict === 'rejected';
  const ok2 = d?.v.verdict === 'lead' && d.v.contacts.primary?.name === 'Achim Berge Olsen' && d.v.contacts.excluded.some((x) => /Bolduan/.test(x.name) && x.rule === 'rep_other_company');
  console.log(`\nNAMED EXAMPLES\n  ${ok1 ? 'PASS' : 'FAIL'}  Nadara / Bellrock — ${n ? `${n.v.verdict}: ${n.v.rules.map((r) => r.id).join(', ')} (status today: ${n.l.status})` : 'lead not found'}`);
  console.log(`  ${ok2 ? 'PASS' : 'FAIL'}  DWT / Riffgat — ${d ? `${d.v.verdict}; contact ${d.v.contacts.primary?.name ?? 'none'}; excluded ${d.v.contacts.excluded.map((x) => x.name).join(', ') || 'nobody'}` : 'lead not found'}`);
  if (!ok1) failures++;
  if (!ok2) failures++;
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
