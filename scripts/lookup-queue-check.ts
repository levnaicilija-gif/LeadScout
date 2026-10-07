/**
 * The paid lookup queue spends money, so every clause that narrows it is asserted here.
 *
 *   npx tsx --env-file=.env.local scripts/lookup-queue-check.ts
 *
 * WHAT THIS EXISTS FOR (2026-10-07). The six NES / Fircroft rows are brand names of one RECRUITMENT AGENCY —
 * a competitor, not a prospect — and they were kept out of this queue only by ACCIDENT: they carry no country
 * and already have a domain. The board crawl has excluded `employer_type = 'staffing_agency'` since item 1;
 * this route never did, so the protection rested on two unrelated facts that one future edit could remove.
 *
 * BOTH ARMS, and the second is the one that matters: a clause narrow enough to exclude an agency is also
 * narrow enough to exclude a real prospect, and an over-narrow queue costs coverage silently — nobody ever
 * sees the company that was not looked up. So this asserts the agency is OUT and that the queue is still
 * NON-EMPTY and still contains ordinary companies.
 *
 * ITS BLIND SPOT, STATED PLAINLY: the live-data arm REPRODUCES the route's predicate rather than calling the
 * route, so deleting the clause from the route does not make that arm fail — proved by mutation, where only
 * the source arm went red. The source arm is therefore the one guarding the route, and the data arm asserts
 * the current state of the table. Calling the route for real would need the cron secret and would spend money
 * per company, which is not something a gate step may do.
 */
import { readFileSync } from 'fs';
import { probeAdmin } from '../src/lib/test-data';
import { crawlWorkspace } from '../src/lib/crawl-workspace';

let fail = 0;
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail++;
};

const ROUTE = 'src/app/api/jobs/resolve-domains/route.ts';
const RELEVANT = ['offshore_wind', 'shipyard', 'oil_gas', 'epc', 'industrial', 'marine_contractor', 'om_service'];
const COUNTRIES = ['DK', 'NL', 'NO', 'DE', 'GB', 'BE', 'SE', 'IE', 'FI', 'ES'];

(async () => {
  // ---- ARM 1: the clause is in the route, in its null-safe form.
  const src = readFileSync(ROUTE, 'utf8');
  check(/employer_type\.is\.null,employer_type\.neq\.staffing_agency/.test(src),
    'the queue excludes staffing_agency',
    /employer_type/.test(src) ? '' : 'NO employer_type filter at all — an agency would be paid for');
  // The null-safe shape is part of the rule: a plain .neq() drops every unjudged company.
  check(!/\.neq\(\s*['"]employer_type['"]\s*,\s*['"]staffing_agency['"]\s*\)/.test(src),
    'and does it null-safely, not with a bare .neq()',
    'a bare .neq() is NULL for a null employer_type, which silently drops unclassified companies');

  // ---- ARM 2: against the live database, reproducing the predicate.
  const db = probeAdmin();
  const ws = await crawlWorkspace(db);
  const pool: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('companies')
      .select('id, name, sector, country, employer_type, domain_lookups')
      .eq('workspace_id', ws).in('country', COUNTRIES).in('sector', RELEVANT)
      .is('domain', null).is('careers_checked_at', null)
      .or('careers_status.is.null,careers_status.neq.no_domain_found')
      .or('employer_type.is.null,employer_type.neq.staffing_agency')
      .lt('domain_lookups', 2).order('id').range(from, from + 999);
    if (error) { check(false, 'the eligible pool could be read', error.message); return; }
    pool.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const agencies = pool.filter((c) => c.employer_type === 'staffing_agency');
  check(agencies.length === 0, 'no staffing agency is in the eligible pool',
    agencies.length ? `${agencies.length} present: ${agencies.slice(0, 3).map((a) => a.name).join(', ')}` : `${pool.length} companies, none an agency`);
  // NOT VACUOUS: an empty pool would satisfy the assertion above while meaning the queue is broken.
  check(pool.length > 0, 'and the pool is not empty, so that assertion means something', `${pool.length} companies eligible`);
  check(pool.some((c) => c.employer_type !== 'staffing_agency'), 'ordinary companies are still queued',
    `${pool.filter((c) => c.employer_type !== 'staffing_agency').length} non-agency companies`);

  // ---- ARM 3: the tagged agencies really are tagged, so arm 2 is testing something.
  const { count: tagged, error: tErr } = await db.from('companies').select('*', { count: 'exact', head: true })
    .eq('workspace_id', ws).eq('employer_type', 'staffing_agency');
  if (tErr) check(false, 'the agency count could be read', tErr.message);
  else check((tagged ?? 0) > 0, 'there ARE tagged agencies to exclude', `${tagged} tagged staffing_agency`);

  console.log(`\nlookup queue: ${fail ? `${fail} FAILED` : 'all checks passed'}`);
  process.exitCode = fail ? 1 : 0;
})();
