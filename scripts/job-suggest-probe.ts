/**
 * Item 25 end to end: the suggestion list narrows, explains itself, and never offers a non-job.
 *
 *   npx tsx --env-file=.env.local scripts/job-suggest-probe.ts http://localhost:3007
 *
 * Seeded so that A LIST RETURNING EVERYTHING FAILS, which is the queue item's own instruction: one
 * posting is a plain trade match, one is reachable ONLY through a confirmed certificate, and the
 * other six are each excluded for a different, nameable reason. A pre-filter that quietly kept the
 * board would spend EUR 0.015 a job and still pass a test that only counted rows.
 *
 * It drives the REAL ROUTE through a signed-in browser session rather than calling the library, so
 * the auth, the RLS read of job_posts and the metering are all exercised. Two jobs reach the model,
 * about EUR 0.03, logged as test spend.
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { markWorkspaceTest, followAllForProbe, removeProbe } from '../src/lib/test-data';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const stamp = Date.now();

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
/** Every insert is read. A seed that failed silently is a probe that proves nothing. */
const must = <T,>(r: { data: T | null; error: { message: string } | null }, what: string): NonNullable<T> => {
  if (r.error) throw new Error(`seeding ${what} failed: ${r.error.message}`);
  if (!r.data) throw new Error(`seeding ${what} returned no row`);
  return r.data as NonNullable<T>;
};

(async () => {
  // --- the account -------------------------------------------------------------------------
  const email = `job-suggest-probe+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data: created, error: userError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { name: 'Job Suggest Probe', agency: 'Job Suggest Probe' },
  });
  if (userError) throw new Error(`could not create the probe account: ${userError.message}`);
  const uid = created.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);
  const followProblem = await followAllForProbe(admin, uid);
  // Read the returned problem — today-probe discarded this one and spent a whole run on /app/onboarding.
  if (followProblem) throw new Error(`the probe account could not follow all industries: ${followProblem}`);
  await admin.from('users').update({ role: 'senior', onboarding_day: 30 }).eq('id', uid);

  let ok = false;
  try {
    // --- the board ---------------------------------------------------------------------------
    const company = must<{ id: string }>(await admin.from('companies').insert({
      workspace_id: workspace, name: `Suggest Co ${stamp}`, country: 'DK', employer_type: 'end_client', is_test: true,
    }).select('id').single(), 'the company');

    // Eight postings. Exactly TWO should survive the pre-filter.
    const BOARD = [
      { key: 'welder-dk',    role: 'Sveiser til rørarbeid',  trades: ['welder'],     country: 'DK', survives: true  },
      { key: 'ndt-dk',       role: 'NDT inspector',          trades: ['ndt'],        country: 'DK', survives: true  },
      { key: 'scaffolder',   role: 'Stillasbygger',          trades: ['scaffolder'], country: 'DK', survives: false },
      { key: 'electrician',  role: 'Elektriker',             trades: ['electrician'],country: 'DK', survives: false },
      { key: 'painter',      role: 'Industrial painter',     trades: ['painter'],    country: 'DK', survives: false },
      { key: 'welder-uk',    role: 'Welder',                 trades: ['welder'],     country: 'GB', survives: false },
      { key: 'welder-us',    role: 'Welder',                 trades: ['welder'],     country: 'US', survives: false },
      // Step 3's gate, proved here on data rather than in a fixture: it carries the candidate's own
      // trade and would otherwise be a perfectly good match.
      { key: 'navigation',   role: 'Browse job offers',      trades: ['welder'],     country: 'DK', survives: false },
    ];
    must(await admin.from('job_posts').insert(BOARD.map((j) => ({
      workspace_id: workspace, company_id: company.id, status: 'open',
      role: j.role, country: j.country, trades: j.trades,
      // Unreachable on purpose: the resolver must fall back to the title rather than fail the job,
      // and this probe must never depend on somebody else's website being up.
      source_url: `https://example.invalid/suggest/${stamp}/${j.key}`,
      posted_at: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10), is_test: true,
    }))).select('id'), 'the postings');

    // --- the person --------------------------------------------------------------------------
    // A Romanian welder: EU passport, NO UK right to work, one CONFIRMED CSWIP (which covers NDT)
    // and one UNCONFIRMED FROSIO (which must widen nothing — the painter job proves it).
    const cand = must<{ id: string }>(await admin.from('candidates').insert({
      workspace_id: workspace, full_name: `Suggest Probe ${stamp}`, trade: 'welder',
      nationality: 'RO', eu_passport: true, uk_right_to_work: false,
      reference_code: `RFBT-S-${String(stamp).slice(-6)}`, created_via: 'verify', created_by: uid,
      profile: { trade: 'welder', full_name: `Suggest Probe ${stamp}`, certificates: [{ body: 'cswip' }] },
    }).select('id').single(), 'the candidate');

    const mkCert = async (body: string, state: string, result: string) => {
      const doc = must<{ id: string }>(await admin.from('documents').insert({
        workspace_id: workspace, candidate_id: cand.id, type: 'certificate', cert_body: body,
        storage_path: `test/${stamp}/${body}.pdf`, uploaded_by: uid, is_test: true,
      }).select('id').single(), `the ${body} document`);
      must(await admin.from('verifications').insert({
        document_id: doc.id, method: 'browser_lookup', result, state,
        checked_where: `https://example.invalid/${body}`, checked_at: new Date().toISOString(),
        valid_until: '2028-01-17',
      }).select('id').single(), `the ${body} verification`);
    };
    await mkCert('cswip', 'verified_register', 'valid');
    await mkCert('frosio', 'pending_issuer', 'pending');

    // --- ask the real route, as a signed-in recruiter ----------------------------------------
    const browser = await chromium.launch();
    const page = await browser.newPage();
    let res: any = null;
    try {
      await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.fill('input[type=email]', email);
      await page.fill('input[type=password]', password);
      // The sign-in button carries no type attribute, so `button[type=submit]` matches nothing and
      // the probe dies on a 30 s timeout with "could not sign in" nowhere in the message.
      await page.click('form button:not([type=button])');
      await page.waitForURL(/\/app\//, { timeout: 60000 });
      const landed = new URL(page.url()).pathname;
      check(!landed.startsWith('/app/onboarding'), 'the probe signs in to the app, not to onboarding', landed);

      res = await page.evaluate(async (candidateId) => {
        const r = await fetch('/api/candidate/suggest', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ candidate_id: candidateId }),
        });
        return { status: r.status, body: await r.text() };
      }, cand.id);
    } finally { await browser.close(); }

    check(res?.status === 200, 'the suggestion route answers', `HTTP ${res?.status}`);
    let json: any = null;
    try { json = JSON.parse(res.body); } catch { /* reported below */ }
    if (!json) {
      check(false, 'and answers with JSON', String(res?.body).slice(0, 200));
      throw new Error('no JSON to assert on — the checks below cannot run');
    }
    if (json.error) {
      check(false, 'and without an error', String(json.error).slice(0, 200));
      throw new Error(`the route reported: ${json.error}`);
    }

    console.log(`\n  considered ${json.considered} · shortlisted ${json.shortlisted} · scored ${json.matches.length} · ${(json.ms / 1000).toFixed(1)}s`);
    for (const m of json.matches) console.log(`      ${String(m.score).padStart(3)}  ${m.role}  [from ${m.from}, ${m.chars} chars]${m.blockers.length ? `  BLOCKED: ${m.blockers[0].slice(0, 48)}` : ''}`);

    const roles: string[] = json.matches.map((m: any) => m.role);
    const expected = BOARD.filter((j) => j.survives).map((j) => j.role);

    console.log('');
    // Item 20 step 3c: the route reads the SHARED pool, so the shortlist is no longer drawn from this
    // probe's eight seeded postings alone — it kept 10 where 2 were seeded as plausible. What still has
    // to hold is that it NARROWS: a filter that passed everything through would spend the daily cap on
    // the first CV of the morning, which is the whole reason it exists.
    check(json.shortlisted < json.considered && json.shortlisted > 0,
      'the pre-filter narrows the pool rather than passing it through',
      `${json.shortlisted} kept of ${json.considered} considered — ${BOARD.length} of those were seeded here`);

    // THIS ASSERTION IS WEAKER THAN IT WAS, and the loss is stated rather than hidden. It used to be
    // that BOTH seeded plausible postings were scored. With a shared pool the route scores the top
    // SHOW=5 of a shortlist that now contains other workspaces' adverts, so whether a seeded posting
    // reaches the top five is not this probe's to control — it depends on RFBT's board. At least one
    // must still get through, or the pre-filter is dropping plausible work. The assertions that carry
    // the weight here are the ABSENCE ones below: they are what prove each gate fires, and none of them
    // is affected by the pool.
    check(expected.some((r) => roles.includes(r)),
      'at least one plausible seeded posting is still scored', `${roles.join(' · ')} — seeded plausible: ${expected.join(' · ')}`);
    check(!roles.includes('Browse job offers'), 'the navigation row is NEVER offered as a match — step 3\'s gate, on real rows');
    check(!roles.includes('Stillasbygger') && !roles.includes('Elektriker'), 'a scaffolding or electrical job is not suggested to a welder');
    check(!roles.includes('Industrial painter'), 'and an UNCONFIRMED certificate widens nothing — the painter job stays out');
    // NOT "no unblocked job called Welder", which is what this asserted first: both Welder rows are
    // dropped by the pre-filter, so that check passed against a list that could never contain one —
    // vacuous, and it would have gone on passing with the geography and right-to-work gates deleted.
    // The real claim is that they never reach the model at all, and the mutation proves it does fail.
    check(!roles.includes('Welder'),
      'the UK job and the job outside Europe are dropped BEFORE anything is spent on them', roles.join(' · ') || 'none');
    check(json.considered >= BOARD.length, 'the route read the board as the signed-in user', `${json.considered} postings visible`);
    check(typeof json.scope === 'string' && json.scope.length > 0, 'it says what it looked at', json.scope);
    check(/posting/i.test(json.scope), 'and that it was postings rather than the whole board — leads are not covered yet', json.scope);

    // Every scored job says how much there was to judge. These adverts are unreachable on purpose,
    // so every one must fall back to its title rather than fail or invent.
    check(json.matches.every((m: any) => ['description', 'fetched', 'title'].includes(m.from)),
      'every match says where its job text came from');
    // Scoped to the SEEDED adverts: those are the ones deliberately made unreachable, so those are the
    // ones that must fall back to their title. A pool advert that fetched successfully reads 'fetched'
    // and is not this assertion's business — before 3c there were no pool adverts in the list to confuse
    // it, and afterwards `every` failed on a route doing exactly the right thing.
    const seededRoles = BOARD.map((j) => j.role);
    const seededMatches = json.matches.filter((m: any) => seededRoles.includes(m.role));
    check(seededMatches.length > 0 && seededMatches.every((m: any) => m.from === 'title'),
      'a SEEDED advert that cannot be read falls back to its title instead of losing the job',
      seededMatches.length ? seededMatches.map((m: any) => `${m.role}:${m.from}`).join(', ') : 'no seeded advert reached the top five, so this could not be judged');
    check(json.matches.every((m: any) => typeof m.score === 'number'), 'and each carries a score');

    ok = failures === 0;
  } finally {
    // clearTestWorkspace does not reach candidates, their documents and verifications, or the
    // companies a posting hangs off, so the workspace delete fails on companies_workspace_id_fkey
    // and strands the whole workspace — which is exactly what the first run of this probe did.
    // Deleted here in foreign-key order, and every delete is read.
    const problems: string[] = [];
    const del = async (table: string, column: string, value: string) => {
      const { error } = await admin.from(table).delete().eq(column, value);
      if (error) problems.push(`${table}: ${error.message}`);
    };
    const { data: cands } = await admin.from('candidates').select('id').eq('workspace_id', workspace);
    for (const c of cands ?? []) {
      const { data: docs } = await admin.from('documents').select('id').eq('candidate_id', c.id);
      for (const d of docs ?? []) await del('verifications', 'document_id', d.id);
      await del('documents', 'candidate_id', c.id);
    }
    await del('candidates', 'workspace_id', workspace);
    await del('job_posts', 'workspace_id', workspace);
    await del('companies', 'workspace_id', workspace);
    for (const p of problems) console.log(`  CLEANUP PROBLEM: ${p}`);
    failures += problems.length;

    const left = await removeProbe(admin, uid, workspace, null, { clearContent: true });
    console.log(left ? `\n  CLEANUP PROBLEM: ${left}` : '\n  the probe account, its workspace and everything seeded were removed');
    if (left) failures++;
  }

  console.log(failures ? `\njob suggest probe: ${failures} FAILED` : `\njob suggest probe: all checks passed${ok ? '' : ''}`);
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(`\njob suggest probe: ${e?.message ?? e}`); process.exitCode = 1; });
