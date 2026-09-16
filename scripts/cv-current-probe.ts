/**
 * Item 24 follow-up 3, step 9: when a candidate has more than one CV, the newest by upload date is the current one — for
 * the Files list, Read CV and the profile the client version reads — and older CVs stay on file as history (owner's
 * decision, 2026-09-15). No model reads: the CVs' readings are seeded, and attaching goes through the real route as a
 * signed-in recruiter.
 *
 *   npx tsx --env-file=.env.local scripts/cv-current-probe.ts https://leadscout-rfbt.vercel.app
 *
 * In a throwaway test workspace, a candidate whose CV was read three days ago says "Welder":
 *   1. an older CV (read a week ago, "Blaster") attached later is kept and changes nothing — the profile still says
 *      Welder, the Files list marks the three-day-old CV current, and Read CV reads it;
 *   2. a newer CV (today, "Scaffolder") attached the same way becomes current — the profile says Scaffolder, the Files
 *      list marks it current, and Read CV reads it;
 *   3. all three CVs stay on file and in the list, at 1500px and at 390px, with nothing scrolling sideways.
 * Everything it made is removed afterwards; a leftover fails the run.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe } from '../src/lib/test-data';
import { hasCandidateCrm } from '../src/lib/schema-features';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const EMAIL = `cv-current-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = `probe-${Date.now()}-0123456789`;
const NAME = 'Probe Current Person';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const shim = 'globalThis.__name = globalThis.__name || function (f) { return f; };';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };
const hydrated = (p: Page) => p.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', undefined, { timeout: 60000 }).catch(() => {});
const sideways = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
const profile = (trade: string) => ({ full_name: NAME, trade, trade_code: 'W', trades: [trade.toLowerCase()], languages: ['English (B2)'], projects: [{ years: '2020-2025', type: `${trade.toLowerCase()} work`, country: 'Norway' }], certificates_claimed: [], skills: [], pii: {} });

(async () => {
  const crm = await hasCandidateCrm(admin);
  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { name: 'CV Current Probe', agency: 'CV Current Probe' } });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);
  await admin.from('users').update({ role: 'recruiter', onboarding_day: 30 }).eq('id', uid);
  await followAllForProbe(admin, uid);

  const ref = `PROBE${Date.now().toString().slice(-5).replace(/\d/g, (d) => 'ABCDEFGHIJ'[Number(d)])}-W-9111`;
  const { data: cand } = await admin.from('candidates').insert({ workspace_id: workspace, reference_code: ref, trade_code: 'W', full_name: NAME, trade: 'Welder', profile: profile('Welder'), created_via: 'manual', created_by: uid, is_test: true, ...(crm ? { owner_id: uid } : {}) }).select('id').single();
  const cv = async (label: string, trade: string, uploadedAt: string, candidateId: string | null) => (await admin.from('documents').insert({
    workspace_id: workspace, candidate_id: candidateId, type: 'cv', storage_path: `cv-current-probe/${ref}-${label}.pdf`, uploaded_by: uid, uploaded_at: uploadedAt, is_test: true,
    extracted: { doc_type: 'cv', holder: NAME, profile: profile(trade) },
  }).select('id').single()).data!.id as string;
  const threeDays = await cv('three-days', 'Welder', daysAgo(3), cand!.id);
  const weekOld = await cv('week-old', 'Blaster', daysAgo(7), null);
  const today = await cv('today', 'Scaffolder', new Date().toISOString(), null);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    await page.addInitScript({ content: shim });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});

    const state = async (p: Page) => {
      await p.goto(`${BASE}/app/candidates/${cand!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(p);
      const listed = await p.locator('[data-candidate-file="cv"]').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-file-id'), current: e.getAttribute('data-file-current') === 'true' })));
      const { data: row } = await admin.from('candidates').select('trade, profile').eq('id', cand!.id).single();
      await p.goto(`${BASE}/app/candidates/${cand!.id}/cv`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const readCv = (await p.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
      return { listed, current: listed.filter((f) => f.current).map((f) => f.id), trade: row?.trade, profileTrade: (row?.profile as any)?.trade, readCv };
    };
    const attach = async (documentId: string) => {
      const r = await page.request.post(`${BASE}/api/verify/attach`, { data: { documentId, candidateId: cand!.id } });
      return r.status();
    };

    // ---- 1. an older CV attached later
    const olderStatus = await attach(weekOld);
    const s1 = await state(page);
    check(olderStatus === 200 && s1.trade === 'Welder' && s1.profileTrade === 'Welder', 'an older CV attached later is kept and does not replace the reading — the profile still says Welder', `HTTP ${olderStatus} · trade ${s1.trade} · profile ${s1.profileTrade}`);
    check(s1.listed.length === 2 && s1.current.length === 1 && s1.current[0] === threeDays && /Welder/.test(s1.readCv) && !/Blaster/.test(s1.readCv), 'the Files list marks the three-day-old CV current, and Read CV reads it', JSON.stringify({ listed: s1.listed.length, currentIsNewest: s1.current[0] === threeDays }));

    // ---- 2. a newer CV attached
    const newerStatus = await attach(today);
    const s2 = await state(page);
    check(newerStatus === 200 && s2.trade === 'Scaffolder' && s2.profileTrade === 'Scaffolder', "a newer CV becomes current — the profile, which the client version reads, says Scaffolder", `HTTP ${newerStatus} · trade ${s2.trade} · profile ${s2.profileTrade}`);
    check(s2.listed.length === 3 && s2.current.length === 1 && s2.current[0] === today && /Scaffolder/.test(s2.readCv), "the Files list marks today's CV current, and Read CV reads it", JSON.stringify({ listed: s2.listed.length, currentIsToday: s2.current[0] === today }));

    // ---- 3. history kept, both widths
    const { data: kept } = await admin.from('documents').select('id').eq('candidate_id', cand!.id).eq('type', 'cv');
    check((kept ?? []).length === 3, 'all three CVs stay on file — older versions are history, not deleted', `${(kept ?? []).length} CV(s)`);
    const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const m = await phone.newPage();
    await m.addInitScript({ content: shim });
    await m.goto(`${BASE}/app/candidates/${cand!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(m);
    const mRows = await m.locator('[data-candidate-file="cv"]').count();
    check(mRows === 3 && await sideways(m) <= 1, 'at 390px the three CVs are listed and nothing scrolls sideways', `${mRows} row(s) · ${await sideways(m)}px`);
    await phone.close();
  } finally {
    await browser.close();
    const leftBehind = await removeProbe(admin, uid, workspace, null, { clearContent: true });
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); } else console.log('\nprobe user, its workspace, candidate and CVs removed');
  }
  console.log(failures === 0 ? 'cv current probe: all checks passed' : `cv current probe: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
