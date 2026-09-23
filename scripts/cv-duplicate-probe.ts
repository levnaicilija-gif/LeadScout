/**
 * The same CV dropped twice never makes two people.
 *
 *   npx tsx --env-file=.env.local scripts/cv-duplicate-probe.ts http://localhost:3000
 *
 * This is the real bug of 2026-09-22 turned into a standing check. A recruiter dropped one CV twice,
 * 85 seconds apart, and got RFBT-P-0625 and RFBT-P-0626: the same person, the same file byte for
 * byte, and no warning on screen. The duplicate rule was never at fault — it was asked about an
 * empty pool, because the read that filled the pool had failed and its `{ error }` was dropped.
 *
 * It drives the REAL route through a signed-in browser, with the REAL file, because every offline
 * check here passed on the day this happened. Two CV readings, about EUR 0.04, logged as test spend.
 *
 * TWO MECHANISMS CAN CATCH IT and the probe says which did: the same-file hash (0044) and, where
 * that column is not applied yet, item 24's name-plus-a-second-field rule. The ASSERTION is the same
 * either way — nothing is created and the screen explains itself — because that is the behaviour the
 * recruiter depends on, not the mechanism behind it.
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { markWorkspaceTest, followAllForProbe, removeProbe } from '../src/lib/test-data';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const stamp = Date.now();

const CV = ['.cache/repro/Marian_M_CV_-_SANDBLASTER.docx', 'fixtures/sandblaster-cv.docx'].find((p) => existsSync(p));

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

(async () => {
  if (!CV) { console.error('no CV fixture on disk — expected fixtures/sandblaster-cv.docx'); process.exitCode = 1; return; }
  const buffer = readFileSync(CV);

  const email = `cv-dupe-probe+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data: made, error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: 'Cv Dupe Probe', agency: 'Cv Dupe Probe' } });
  if (userError) throw new Error(`could not create the probe account: ${userError.message}`);
  const uid = made.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);
  const followProblem = await followAllForProbe(admin, uid);
  if (followProblem) throw new Error(`the probe account could not follow all industries: ${followProblem}`);
  await admin.from('users').update({ role: 'senior', onboarding_day: 30 }).eq('id', uid);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', email);
    await page.fill('input[type=password]', password);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 });
    check(!new URL(page.url()).pathname.startsWith('/app/onboarding'), 'the probe signs in to the app, not to onboarding', new URL(page.url()).pathname);

    const drop = async () => {
      const r = await page.request.post(`${BASE}/api/verify/intake`, {
        multipart: { files: { name: 'Marian_M_CV_-_SANDBLASTER.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer } },
        timeout: 180000,
      });
      const j = await r.json();
      const cand = (j.candidates ?? [])[0];
      const loose = (j.loose ?? [])[0];
      return { status: r.status(), json: j, file: cand?.files?.[0] ?? loose, reference: cand?.reference_code ?? null };
    };

    const first = await drop();
    check(first.status === 200, 'the first drop is accepted', `HTTP ${first.status}`);
    check(!!first.reference, 'and opens a record for somebody nobody had', String(first.reference));

    const second = await drop();
    check(second.status === 200, 'the second drop is accepted too — it is not an error', `HTTP ${second.status}`);
    check(!second.reference, 'and opens NO second record for the same person', second.reference ?? 'none created');

    // The assertion that would have failed on 2026-09-22.
    const { count } = await admin.from('candidates').select('*', { count: 'exact', head: true }).eq('workspace_id', workspace);
    check(count === 1, 'one CV dropped twice leaves ONE person in the pool', `${count} candidate(s)`);

    check(!!second.file?.needsDecision, 'the screen says why nothing was created, rather than silently doing nothing', String(second.file?.needsDecision ?? 'nothing said').slice(0, 110));
    const suggest = second.file?.suggest ?? [];
    check(suggest.length > 0, 'and offers the record it matched', JSON.stringify(suggest.map((s: any) => s.reference)));
    check(suggest.some((s: any) => s.reference === first.reference), 'which is the one the first drop opened', String(first.reference));

    // Which mechanism caught it — reported, not asserted, because either is correct.
    const by = second.file?.sameFile ? 'the content hash (0044)' : 'item 24\'s name + date of birth rule';
    console.log(`\n  caught by: ${by}`);
    if (second.file?.sameFile) check(/byte for byte/i.test(second.file.sameFile), 'the same-file message says what it means', second.file.sameFile);

    // A duplicate must never be stored a second time either — that is the clutter one level down.
    const { count: docs } = await admin.from('documents').select('*', { count: 'exact', head: true }).eq('workspace_id', workspace);
    check((docs ?? 0) <= 2, 'the file is not stored twice over', `${docs} document(s)`);
  } finally {
    await browser.close();
    const { data: cs } = await admin.from('candidates').select('id').eq('workspace_id', workspace);
    for (const c of cs ?? []) { await admin.from('documents').delete().eq('candidate_id', c.id); await admin.from('anonymized_cvs').delete().eq('candidate_id', c.id); }
    await admin.from('documents').delete().eq('workspace_id', workspace);
    await admin.from('candidates').delete().eq('workspace_id', workspace);
    const left = await removeProbe(admin, uid, workspace, null, { clearContent: true });
    if (left) { console.log(`\n  CLEANUP PROBLEM: ${left}`); failures++; }
    else console.log('\n  the probe account, its workspace and everything seeded were removed');
  }

  console.log(failures ? `\ncv duplicate probe: ${failures} FAILED` : '\ncv duplicate probe: all checks passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(`\ncv duplicate probe: ${e?.message ?? e}`); process.exitCode = 1; });
