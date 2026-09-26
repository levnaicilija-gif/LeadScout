/**
 * Item 24 follow-up 3, step 3 on screen: the "Drop CVs to add candidates" overlay is up only while a file is being dragged,
 * and never stays behind. As a signed-in recruiter in a throwaway test workspace, at 1500px, on Home, Today, Candidates,
 * a candidate's page and Campaigns. Nothing is dropped, so nothing is read or stored.
 *
 *   npx tsx --env-file=.env.local scripts/drop-overlay-probe.ts https://leadscout-rfbt.vercel.app
 *
 * On each screen, a file dragged the ways a person drags one:
 *   1. held over the page, then the cursor leaves the window without dropping — the overlay goes;
 *   2. dragged over the page and across an element, with the browser sending one dragleave fewer than it sent dragenters
 *      (an element re-rendered under the cursor) — the overlay still goes, once dragover stops arriving;
 *   3. held over the page, then the drag is cancelled (Escape) with no further event at all — the overlay goes;
 *   4. moved over the page continuously for three seconds — the overlay stays up the whole time, then goes when it leaves;
 *   5. (rail screens and Home) held over the "Drop a CV here" zone, then cancelled — the zone's highlight goes too.
 * On the candidate's page, 4 is done over the certificate zone, which stops the event from reaching the page.
 * Everything it made is removed afterwards; a leftover fails the run.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium, type JSHandle, type Page } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe, probeAdmin } from '../src/lib/test-data';
import { hasCandidateCrm } from '../src/lib/schema-features';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const EMAIL = `drop-overlay-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = `probe-${Date.now()}-0123456789`;
const admin = probeAdmin();
const shim = 'globalThis.__name = globalThis.__name || function (f) { return f; };';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };
const hydrated = (p: Page) => p.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', undefined, { timeout: 60000 }).catch(() => {});
const overlayUp = (p: Page) => p.evaluate(() => document.querySelectorAll('[data-candidate-drop-overlay]').length > 0);
/** Waits for the overlay (or a lit zone) to be gone — a state, not a sleep. */
const goneWithin = (p: Page, sel: string, ms: number) => p.waitForFunction((s) => document.querySelectorAll(s).length === 0, sel, { timeout: ms }).then(() => true).catch(() => false);

const fileTransfer = (p: Page) => p.evaluateHandle(() => {
  const t = new DataTransfer();
  t.items.add(new File(['not dropped'], 'cv.pdf', { type: 'application/pdf' }));
  return t;
});
const fire = (p: Page, target: string, type: string, dt: JSHandle) => p.dispatchEvent(target, type, { dataTransfer: dt });

(async () => {
  const crm = await hasCandidateCrm(admin);
  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Drop Overlay Probe', agency: 'Drop Overlay Probe' } });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);
  await admin.from('users').update({ role: 'recruiter', onboarding_day: 30 }).eq('id', uid);
  await followAllForProbe(admin, uid);
  const ref = `PROBE${Date.now().toString().slice(-5).replace(/\d/g, (d) => 'ABCDEFGHIJ'[Number(d)])}-P-9110`;
  const { data: cand } = await admin.from('candidates').insert({ workspace_id: workspace, reference_code: ref, trade_code: 'P', full_name: 'Probe Overlay Person', trade: 'Painter', profile: { full_name: 'Probe Overlay Person', pii: {} }, created_via: 'manual', created_by: uid, is_test: true, ...(crm ? { owner_id: uid } : {}) }).select('id').single();

  const SCREENS: [string, string, 'home' | 'rail' | null][] = [
    ['Home', '/app/home', 'home'], ['Today', '/app/today', 'rail'], ['Candidates', '/app/candidates', 'rail'],
    ["a candidate's page", `/app/candidates/${cand?.id}`, 'rail'], ['Campaigns', '/app/campaigns', 'rail'],
  ];

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    await page.addInitScript({ content: shim });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});

    for (const [screen, path, zone] of SCREENS) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(page);
      const dt = await fileTransfer(page);

      // 1. held over the page, then out of the window
      await fire(page, 'body', 'dragenter', dt);
      await fire(page, 'body', 'dragover', dt);
      const up1 = await overlayUp(page);
      await fire(page, 'body', 'dragleave', dt);
      check(up1 && await goneWithin(page, '[data-candidate-drop-overlay]', 3000), `${screen}: held over the page, the overlay is up; leaving the window without dropping takes it away`, `up ${up1}`);

      // 2. one dragleave fewer than dragenters, then nothing
      const inner = (await page.locator('main h1, h1').count()) ? 'h1' : 'body';
      await fire(page, 'body', 'dragenter', dt);
      await fire(page, inner, 'dragenter', dt);
      await fire(page, inner, 'dragover', dt);
      await fire(page, inner, 'dragleave', dt);
      const up2 = await overlayUp(page);
      check(up2 && await goneWithin(page, '[data-candidate-drop-overlay]', 3000), `${screen}: a dragleave the browser never sent does not leave the overlay stuck`, `up after the unbalanced leave ${up2}`);

      // 3. cancelled with no event at all
      await fire(page, 'body', 'dragenter', dt);
      await fire(page, 'body', 'dragover', dt);
      check(await goneWithin(page, '[data-candidate-drop-overlay]', 3000), `${screen}: a drag cancelled with no further event does not leave the overlay stuck`);

      // 4. a real drag keeps it up — over the certificate zone on the candidate's page, which stops the event
      const over = path.includes('/app/candidates/') && (await page.locator('[data-candidate-doc-drop]').count()) ? '[data-candidate-doc-drop]' : 'body';
      await fire(page, 'body', 'dragenter', dt);
      let steady = true;
      for (let i = 0; i < 15; i++) {
        await fire(page, over, 'dragover', dt);
        await page.waitForTimeout(200);                    // a hand moving a file: dragover every 200 ms, far inside IDLE_MS
        if (!(await overlayUp(page))) steady = false;
      }
      await fire(page, 'body', 'dragleave', dt);
      check(steady && await goneWithin(page, '[data-candidate-drop-overlay]', 3000), `${screen}: dragging continuously for 3 s${over !== 'body' ? ' over the certificate zone' : ''} keeps the overlay up the whole time, and leaving takes it away`, `steady ${steady}`);

      // 5. the zone's highlight
      if (zone) {
        const z = `[data-cv-drop-zone="${zone}"]`;
        await fire(page, z, 'dragenter', dt);
        await fire(page, z, 'dragover', dt);
        const lit = await page.waitForSelector('[data-cv-drop-over="true"]', { timeout: 5000 }).then(() => true).catch(() => false);
        check(lit && await goneWithin(page, '[data-cv-drop-over="true"]', 3000) && await goneWithin(page, '[data-candidate-drop-overlay]', 3000), `${screen}: the "Drop a CV here" zone lights up under a file, and a cancelled drag leaves neither the highlight nor the overlay behind`, `lit ${lit}`);
      }
    }
  } finally {
    await browser.close();
    const leftBehind = await removeProbe(admin, uid, workspace, null, { clearContent: true });
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); } else console.log('\nprobe user, its workspace and its candidate removed');
  }
  console.log(failures === 0 ? 'drop overlay probe: all checks passed' : `drop overlay probe: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
