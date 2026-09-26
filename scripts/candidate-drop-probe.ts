/**
 * Adding a candidate from any screen, on screen, as a signed-in recruiter at 1500px and at 390px on a touch screen (item 24
 * step 1, and its follow-up of 2026-09-15): the "Drop a CV here" zone — dropped on and clicked — a CV dropped anywhere,
 * and the "+ Add CV" button a phone uses instead.
 *
 *   npx tsx --env-file=.env.local scripts/candidate-drop-probe.ts https://leadscout-rfbt.vercel.app
 *
 * Uses the local fixture fixtures/sandblaster-cv.docx (the CV verify-e2e drops). In a throwaway test workspace:
 *   1. Home, 1500px: the zone is on screen and the floating button is not; dragging over the page still shows the overlay;
 *      a CV held over the zone lights it; dropping it there creates one candidate, shown as "#N", from one stored CV.
 *   2. Today, 390px: the button is on screen and no zone; dropping the same CV anywhere on the page asks instead of
 *      creating and names why; "Attach to #N" attaches it — still one candidate, and no loose CV left.
 *   3. 390px: tapping the button opens the file picker; a file that is not a candidate document is not saved, and the panel
 *      says so. Neither width scrolls sideways with the panel open.
 *   4. Every screen a recruiter has — Home, Today, Leads, Pitch, Candidates, Campaigns. At 1500px: exactly one zone (at the
 *      foot of the rail, or Home's card) and no button; a file held over the zone lights it and the overlay leaves the rail
 *      in view; a drop on the zone reaches intake exactly once with that file; clicking the zone opens the file picker and
 *      its file reaches intake. At 390px: the button and no zone; tapping it opens the picker and its file reaches intake.
 *      Here the probe answers intake itself and checks the file names, so these screens cost no model reads — 1–3 read
 *      for real.
 *   5. Verify keeps its own drop zone: no zone, no button and no overlay there, at either width.
 *   6. Every real read was metered as test traffic.
 * The workspace, its candidate and documents are removed afterwards; a leftover fails the run.
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe, probeAdmin } from '../src/lib/test-data';
import { candidateLabel } from '../src/lib/candidate-number';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const CV = 'fixtures/sandblaster-cv.docx';
const NOT_CV = '.cache/not-a-candidate-document.txt';
const EMAIL = `candidate-drop-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = `probe-${Date.now()}-0123456789`;
const admin = probeAdmin();

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };

type Payload = { b64: string; name: string; type: string };
const menu = (name: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`Canteen menu (${name}): soup on Monday, fish on Friday. Not a CV or a certificate.`) });

/**
 * A real drag from outside the browser onto `target`: a DataTransfer carrying the file, dispatched as dragenter and
 * dragover, then drop — or dragleave when `drop` is false. `waitFor` is what the drag should light up before it lets go.
 */
async function dragFileOnto(page: Page, target: string, file: Payload, opts: { drop?: boolean; waitFor?: string } = {}) {
  const dt = await page.evaluateHandle(({ b64, name, type }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], name, { type }));
    return transfer;
  }, file);
  await page.dispatchEvent(target, 'dragenter', { dataTransfer: dt });
  await page.dispatchEvent(target, 'dragover', { dataTransfer: dt });
  if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: 10000 }).catch(() => {});
  const seen = await page.evaluate(() => ({
    overlay: document.querySelectorAll('[data-candidate-drop-overlay]').length,
    overlayLeft: Math.round(document.querySelector('[data-candidate-drop-overlay]')?.getBoundingClientRect().left ?? -1),
    lit: document.querySelector('[data-cv-drop-over="true"]')?.getAttribute('data-cv-drop-zone') ?? null,
  }));
  await page.dispatchEvent(target, opts.drop === false ? 'dragleave' : 'drop', { dataTransfer: dt });
  return seen;
}

async function settled(page: Page) {
  await page.waitForSelector('[data-candidate-drop-panel]', { timeout: 30000 }).catch(() => {});
  return page.waitForFunction(() => document.querySelector('[data-candidate-drop-panel]')?.getAttribute('data-candidate-drop-busy') === 'false'
    && !!document.querySelector('[data-drop-result], [data-candidate-drop-panel] .text-bad'), undefined, { timeout: 180000 }).then(() => true).catch(() => false);
}

/** The panel says this file was not saved (step 4's answered intake, or a real read of a file that is not a CV). */
const rejectedShown = (page: Page, name: string) => page.waitForFunction((n) =>
  document.querySelector('[data-candidate-drop-panel]')?.getAttribute('data-candidate-drop-busy') === 'false'
  && Array.from(document.querySelectorAll('[data-drop-result="rejected"]')).some((e) => (e.textContent ?? '').includes(n)), name, { timeout: 30000 }).then(() => true).catch(() => false);

const closePanel = async (page: Page, touch: boolean) => {
  const close = page.locator('[data-candidate-drop-panel] button', { hasText: 'Close' });
  if (!(await close.count())) return;
  await (touch ? close.tap() : close.click()).catch(() => {});
};

/** Intake answered by the probe: every file name sent is recorded, and each is "not a candidate document". */
const answerIntake = (page: Page, names: string[]) => page.route('**/api/verify/intake', async (route) => {
  const body = route.request().postDataBuffer()?.toString('latin1') ?? '';
  const files = [...body.matchAll(/filename="([^"]+)"/g)].map((x) => x[1]);
  names.push(...files);
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [], loose: files.map((file) => ({ kind: 'other', file })) }) });
});

const visible = (page: Page, sel: string) => page.locator(sel).evaluateAll((els) => els.filter((e) => (e as any).checkVisibility()).length);
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const hydrated = (page: Page) => page.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', undefined, { timeout: 60000 }).catch(() => {});

// The screens a recruiter on day 30 has; Settings is a senior's, and Verify stands aside (step 5).
const SCREENS = [
  ['Home', '/app/home', 'home'], ['Today', '/app/today', 'rail'], ['Leads', '/app/radar', 'rail'],
  ['Pitch', '/app/pitch', 'rail'], ['Candidates', '/app/candidates', 'rail'], ['Campaigns', '/app/campaigns', 'rail'],
] as const;

(async () => {
  if (!fs.existsSync(CV)) { console.error(`${CV} is not on this machine`); process.exit(1); }
  const cv = { b64: fs.readFileSync(CV).toString('base64'), name: 'sandblaster-cv.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Candidate Drop Probe', agency: 'Candidate Drop Probe' } });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);
  await admin.from('users').update({ role: 'recruiter', onboarding_day: 30 }).eq('id', uid);
  const followProblem = await followAllForProbe(admin, uid);
  if (followProblem) console.log(`  ...  ${followProblem}`);
  const startedAt = new Date().toISOString();

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || function (f) { return f; };' });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});
    check(/\/app\//.test(page.url()), 'signed in as a recruiter in a test workspace', page.url());

    // ---- 1. Home at 1500px: drop a CV on the zone, a candidate is created
    await page.goto(`${BASE}/app/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);
    check(await visible(page, '[data-cv-drop-zone="home"]') === 1 && await visible(page, '[data-candidate-drop-button]') === 0, 'at 1500px Home shows the "Drop a CV here" zone and not the floating button');
    const anywhere = await dragFileOnto(page, 'body', cv, { drop: false, waitFor: '[data-candidate-drop-overlay]' });
    check(anywhere.overlay === 1, 'at 1500px dragging a CV over the page still shows the drop overlay');
    const onZone = await dragFileOnto(page, '[data-cv-drop-zone="home"]', cv, { waitFor: '[data-cv-drop-over="true"]' });
    check(onZone.lit === 'home', "at 1500px a CV held over Home's zone lights it up", JSON.stringify(onZone));
    check(await settled(page), 'at 1500px the CV dropped on the zone is read');
    const first = await page.locator('[data-drop-result="created"]').first().innerText().catch(() => '');
    const { data: cands1 } = await admin.from('candidates').select('id, reference_code, full_name, created_via').eq('workspace_id', workspace);
    const { data: cvDocs1 } = await admin.from('documents').select('id').eq('workspace_id', workspace).eq('type', 'cv');
    const cand = cands1?.[0];
    check((cands1 ?? []).length === 1 && !!cand?.reference_code && (cvDocs1 ?? []).length === 1, 'the drop on the zone created exactly one candidate from one stored CV — read once, not twice', `${(cands1 ?? []).length} candidate(s), ${(cvDocs1 ?? []).length} CV document(s)`);
    check(!!cand && first.includes(`New candidate ${candidateLabel(cand.reference_code)}`) && new RegExp(`Open ${candidateLabel(cand.reference_code)}`).test(first), 'the panel shows the new candidate by number', first.replace(/\s+/g, ' '));
    check(await visible(page, '[data-candidate-drop-overlay]') === 0, 'at 1500px the overlay is gone once the CV is dropped');
    check(await sideways(page) <= 1, 'at 1500px nothing scrolls sideways with the panel open', `${await sideways(page)}px`);
    await closePanel(page, false);

    // ---- 2. Today at 390px: the same CV dropped anywhere asks, and attaching makes no second candidate
    const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const m = await phone.newPage();
    await m.addInitScript({ content: 'globalThis.__name = globalThis.__name || function (f) { return f; };' });
    await m.goto(`${BASE}/app/today`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(m);
    check(await visible(m, '[data-candidate-drop-button]') === 1 && await visible(m, '[data-cv-drop-zone]') === 0, 'at 390px Today shows the "+ Add CV" button and no drop zone');
    await dragFileOnto(m, 'body', cv);
    check(await settled(m), 'at 390px the second drop of the same CV is read');
    const ask = m.locator('[data-drop-result="ask"]').first();
    const askText = await ask.innerText().catch(() => '');
    const { data: cands2 } = await admin.from('candidates').select('id').eq('workspace_id', workspace);
    check((cands2 ?? []).length === 1, 'the same CV again created no second candidate', `${(cands2 ?? []).length} candidate(s)`);
    check(/Check before adding/.test(askText) && /(likely the same person|same name only)/.test(askText) && !!cand && askText.includes(`Attach to ${candidateLabel(cand.reference_code)}`), 'at 390px it asks, says why, and offers the candidate by number', askText.replace(/\s+/g, ' ').slice(0, 260));
    check(await sideways(m) <= 1, 'at 390px nothing scrolls sideways with the question open', `${await sideways(m)}px`);
    await ask.locator('button', { hasText: 'Attach to' }).first().tap();
    await m.waitForFunction(() => /✓ Attached/.test(document.querySelector('[data-drop-result="ask"]')?.textContent ?? ''), undefined, { timeout: 30000 }).catch(() => {});
    const attachedText = await ask.innerText().catch(() => '');
    const { data: docs } = await admin.from('documents').select('id, type, candidate_id').eq('workspace_id', workspace).eq('type', 'cv');
    check(!!cand && attachedText.includes(`✓ Attached — ${candidateLabel(cand.reference_code)}`), 'at 390px "Attach to #N" says it attached', attachedText.replace(/\s+/g, ' ').slice(0, 120));
    check((docs ?? []).length === 2 && (docs ?? []).every((d: any) => d.candidate_id === cand?.id), 'both CVs are on the one candidate, none left loose', JSON.stringify(docs?.map((d: any) => d.candidate_id === cand?.id)));

    // ---- 3. Tapping the button opens the file picker, with a file that is not a candidate document
    await closePanel(m, true);
    fs.writeFileSync(NOT_CV, 'Canteen menu for the week of 14 September: soup on Monday, fish on Friday. This is not a CV or a certificate.');
    const picker = await Promise.all([m.waitForEvent('filechooser', { timeout: 30000 }), m.locator('[data-candidate-drop-button]').tap()]).then(([c]) => c).catch(() => null);
    check(!!picker, 'at 390px tapping "+ Add CV" opens the file picker');
    if (picker) await picker.setFiles(NOT_CV);
    check(!!picker && await settled(m), 'at 390px the file chosen in the picker is read');
    const rejected = await m.locator('[data-drop-result="rejected"]').first().innerText().catch(() => '');
    check(/Not saved/.test(rejected), 'at 390px a file that is not a candidate document is not saved, and the panel says so', rejected.replace(/\s+/g, ' '));
    check(await sideways(m) <= 1, 'at 390px nothing scrolls sideways', `${await sideways(m)}px`);
    await closePanel(m, true);

    // ---- 4. Every screen: the zone at 1500px (dropped on and clicked), the button at 390px (tapped)
    const sent: string[] = [];
    await answerIntake(page, sent);
    await answerIntake(m, sent);
    for (const [screen, path, variant] of SCREENS) {
      const slug = screen.toLowerCase();
      const zone = `[data-cv-drop-zone="${variant}"]`;
      await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(page);
      const zones = await visible(page, '[data-cv-drop-zone]');
      const buttons = await visible(page, '[data-candidate-drop-button]');
      const box = await page.locator(zone).boundingBox().catch(() => null);
      // The rail's zone sits at its foot, below the screens: in the lower half of a 1000px window.
      check(zones === 1 && buttons === 0 && !!box && (variant === 'home' || box.y > 500), `1500px ${screen}: one drop zone${variant === 'rail' ? ' at the foot of the rail' : ' on the page'}, no floating button`, `zones ${zones}, buttons ${buttons}, zone top ${box ? Math.round(box.y) : 'none'}px`);

      const dropName = `drop-on-${slug}.txt`;
      const before = sent.length;
      const d = await dragFileOnto(page, zone, { b64: menu(dropName).buffer.toString('base64'), name: dropName, type: 'text/plain' }, { waitFor: '[data-cv-drop-over="true"]' });
      const dropRead = await rejectedShown(page, dropName);
      const hits = sent.slice(before).filter((n) => n === dropName).length;
      const railInView = variant === 'home' ? d.overlayLeft === 0 : d.overlayLeft >= 200;
      check(d.lit === variant && railInView && dropRead && hits === 1, `1500px ${screen}: a file held over the zone lights it${variant === 'rail' ? ', the overlay leaves the rail in view' : ''}, and a drop on it reaches intake exactly once`, `lit ${d.lit}, overlay from ${d.overlayLeft}px, intake got it ${hits}×`);
      await closePanel(page, false);

      const clickName = `click-on-${slug}.txt`;
      const chooser = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), page.locator(zone).click()]).then(([c]) => c).catch(() => null);
      if (chooser) await chooser.setFiles(menu(clickName));
      const clickRead = !!chooser && await rejectedShown(page, clickName);
      check(clickRead && sent.includes(clickName), `1500px ${screen}: clicking the zone opens the file picker, and the chosen file reaches intake`, chooser ? '' : 'no file picker opened');
      await closePanel(page, false);
      check(await visible(page, '[data-candidate-drop-overlay]') === 0 && await sideways(page) <= 1, `1500px ${screen}: no overlay left behind, nothing scrolls sideways`, `${await sideways(page)}px`);

      await m.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(m);
      const mZones = await visible(m, '[data-cv-drop-zone]');
      const mButtons = await visible(m, '[data-candidate-drop-button]');
      const tapName = `tap-on-${slug}.txt`;
      const mChooser = mButtons === 1
        ? await Promise.all([m.waitForEvent('filechooser', { timeout: 15000 }), m.locator('[data-candidate-drop-button]').tap()]).then(([c]) => c).catch(() => null)
        : null;
      if (mChooser) await mChooser.setFiles(menu(tapName));
      const tapRead = !!mChooser && await rejectedShown(m, tapName);
      check(mZones === 0 && mButtons === 1 && tapRead && sent.includes(tapName), `390px ${screen}: the "+ Add CV" button and no drop zone; tapping it opens the file picker, and the chosen file reaches intake`, `zones ${mZones}, buttons ${mButtons}${mChooser ? '' : ', no file picker opened'}`);
      check(await sideways(m) <= 1, `390px ${screen}: nothing scrolls sideways`, `${await sideways(m)}px`);
      await closePanel(m, true);
    }
    await page.unroute('**/api/verify/intake');
    await m.unroute('**/api/verify/intake');

    // ---- 5. Verify keeps its own drop zone, at both widths
    for (const [p, width] of [[page, '1500px'], [m, '390px']] as const) {
      await p.goto(`${BASE}/app/verify`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(p);
      const onVerify = await dragFileOnto(p, 'body', cv, { drop: false });
      const vZones = await visible(p, '[data-cv-drop-zone]');
      const vButtons = await visible(p, '[data-candidate-drop-button]');
      check(onVerify.overlay === 0 && vZones === 0 && vButtons === 0, `${width} on Verify the zone, the button and the overlay stand aside for Verify's own drop zone`, `overlay ${onVerify.overlay}, zones ${vZones}, buttons ${vButtons}`);
    }
    await phone.close();

    // ---- 6. metered
    const { data: cost } = await admin.from('cost_log').select('kind, eur, detail').eq('workspace_id', workspace).gte('created_at', startedAt);
    const kinds = [...new Set((cost ?? []).map((c: any) => c.kind))];
    check((cost ?? []).length > 0 && (cost ?? []).every((c: any) => String(c.detail).startsWith('test workspace')), 'every read was metered as test traffic', `${(cost ?? []).length} attempt(s) · ${kinds.join(', ')} · €${(cost ?? []).reduce((a: number, c: any) => a + Number(c.eur), 0).toFixed(4)}`);
  } finally {
    await browser.close();
    fs.rmSync(NOT_CV, { force: true });
    const leftBehind = await removeProbe(admin, uid, workspace, null, { clearContent: true });
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); } else console.log('\nprobe user, its workspace, candidate and documents removed');
  }
  console.log(failures === 0 ? 'candidate drop probe: all checks passed' : `candidate drop probe: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
