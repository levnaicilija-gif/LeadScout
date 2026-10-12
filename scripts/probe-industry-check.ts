/**
 * Is the probes' industry still free of real data — and would the guard SAY so if it were not? Read-only.
 *
 *   npx tsx --env-file=.env.local scripts/probe-industry-check.ts
 *
 * WHY (2026-10-09). The crawl classified ISS Facility Services as pharma from one advert title, the probes were
 * capped to pharma, and queue-ids and today failed on one extra Hiring now company — reading exactly like a
 * filter regression. capProbeToOneIndustry's guard checked real LEADS only; Hiring now reads postings through
 * COMPANIES. So the guard gained a third condition, and this holds both of its arms against the LIVE database:
 *
 *   FIRES  on an industry that really has a company with an open posting, and names that company — the
 *          industry and the company are found by their own query, never hard-coded, so this arm does not
 *          rot when one company is reclassified;
 *   PASSES on PROBE_INDUSTRY, which is the gate's own isolation.
 *
 * Exits 1 on a failed arm, 2 when no industry anywhere has a real open posting (the firing arm cannot be judged).
 */
import { probeAdmin, probeIndustryConflict, realOpenPostingCompaniesIn, openPostingConflict, PROBE_INDUSTRY } from '../src/lib/test-data';

const db = probeAdmin();
let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

(async () => {
  // An industry with a real company holding an open posting, found independently of the guard.
  const { data, error } = await db.from('job_posts').select('companies!inner(name, industries, is_test)').eq('status', 'open').limit(1000);
  if (error) { console.log(`open postings could not be read: ${error.message}`); process.exitCode = 1; return; }
  const real = (data ?? []).map((r: any) => r.companies).filter((c: any) => c && !c.is_test && (c.industries ?? []).length);
  const pick = real.find((c: any) => !(c.industries as string[]).includes(PROBE_INDUSTRY));
  if (!pick) { console.log('no real company with an open posting carries an industry — the firing arm cannot be judged'); process.exitCode = 2; return; }
  const industry = (pick.industries as string[])[0];

  // The third condition on its own: the leads conditions would fire first on most industries, so the arm
  // that matters here is asked directly rather than through the whole guard.
  const { names, error: e } = await realOpenPostingCompaniesIn(db, industry);
  const fired = names.length ? openPostingConflict(industry, names) : null;
  check(!e && !!fired, `the company condition FIRES on "${industry}", which a real company with an open posting carries`, e ?? fired ?? 'returned nothing');
  const sameIndustry = real.filter((c: any) => (c.industries as string[]).includes(industry)).map((c: any) => c.name);
  check(!!fired && sameIndustry.some((n: string) => fired.includes(n)), 'and names the company, so the next red says WHICH one', `expected one of ${sameIndustry.slice(0, 3).join(', ')}`);
  const whole = await probeIndustryConflict(db, industry);
  check(!!whole, 'and the whole guard refuses that industry too', whole ?? 'returned null');

  const clean = await probeIndustryConflict(db, PROBE_INDUSTRY);
  check(clean === null, `and PASSES on PROBE_INDUSTRY "${PROBE_INDUSTRY}" — the gate's probes are isolated`, clean ?? '');

  console.log(failures ? `\nprobe industry: ${failures} FAILED` : '\nprobe industry: all checks passed');
  process.exitCode = failures ? 1 : 0;
})();
