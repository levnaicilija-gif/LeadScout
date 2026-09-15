/**
 * Item 24 step 1 on screen: add a candidate by dropping a CV anywhere in the app, as a signed-in recruiter, at 1500px and
 * at 390px on a touch screen — drag-and-drop specifically, and the "Add CV" button a phone uses instead.
 *
 *   npx tsx --env-file=.env.local scripts/candidate-drop-probe.ts https://leadscout-rfbt.vercel.app
 *
 * Uses the local fixture fixtures/sandblaster-cv.docx (the CV verify-e2e drops). In a throwaway test workspace:
 *   1. Home, 1500px: the Add CV button is on screen; dragging the CV over the page shows the overlay; dropping it creates
 *      a candidate, shown as "#N" — the number of its reference code — and the database holds exactly one.
 *   2. Today, 390px: dropping the same CV again asks instead of creating (the name and a second field agree) and names why;
 *      "Attach to #N" attaches the CV to that candidate — still exactly one candidate, and no loose CV left.
 *   3. 390px: the Add CV button's file picker takes a file that is not a candidate document, and the panel says it was
 *      not saved. Neither width scrolls sideways with the panel open.
 *   4. Verify keeps its own drop zone: the overlay and the button stand aside there.
 *   5. Every read was metered as test traffic.
 * The workspace, its candidate and documents are removed afterwards; a leftover fails the run.
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe } from '../src/lib/test-data';
import { candidateLabel } from '../src/lib/candidate-number';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const CV = 'fixtures/sandblaster-cv.docx';
const EMAIL = `candidate-drop-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = `probe-${Date.now()}-0123456789`;
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };

/** A real drag from outside the browser: a DataTransfer carrying the file, dispatched as dragenter, dragover, drop. */
async function dragFileOnto(page: Page, file: { b64: string; name: string; type: string }, drop = true) {
  const dt = await page.evaluateHandle(({ b64, name, type }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], name, { type }));
    return transfer;
  }, file);
  await page.dispatchEvent('main, body', 'dragenter', { dataTransfer: dt });
  await page.dispatchEvent('main, body', 'dragover', { dataTransfer: dt });
  const overlay = await page.locator('[data-candidate-drop-overlay]').count();
  if (drop) await page.dispatchEvent('main, body', 'drop', { dataTransfer: dt });
  return overlay;
}

async function settled(page: Page) {
  await page.waitForSelector('[data-candidate-drop-panel]', { timeout: 30000 }).catch(() => {});
  return page.waitForFunction(() => document.querySelector('[data-candidate-drop-panel]')?.getAttribute('data-candidate-drop-busy') === 'false'
    && !!document.querySelector('[data-drop-result], [data-candidate-drop-panel] .text-bad'), undefined, { timeout: 180000 }).then(() => true).catch(() => false);
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const hydrated = (page: Page) => page.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', undefined, { timeout: 60000 }).catch(() => {});

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

    // ---- 1. Home at 1500px: drop a CV, a candidate is created
    await page.goto(`${BASE}/app/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);
    check(await page.locator('[data-candidate-drop-button]').isVisible(), 'at 1500px the Add CV button is on Home');
    const overlay = await dragFileOnto(page, cv);
    check(overlay === 1, 'at 1500px dragging a CV over the page shows the drop overlay');
    check(await settled(page), 'at 1500px the dropped CV is read');
    const first = await page.locator('[data-drop-result="created"]').first().innerText().catch(() => '');
    const { data: cands1 } = await admin.from('candidates').select('id, reference_code, full_name, created_via').eq('workspace_id', workspace);
    const cand = cands1?.[0];
    check((cands1 ?? []).length === 1 && !!cand?.reference_code, 'the drop created exactly one candidate', JSON.stringify(cands1));
    check(!!cand && first.includes(`New candidate ${candidateLabel(cand.reference_code)}`) && new RegExp(`Open ${candidateLabel(cand.reference_code)}`).test(first), 'the panel shows the new candidate by number', first.replace(/\s+/g, ' '));
    check(await sideways(page) <= 1, 'at 1500px nothing scrolls sideways with the panel open', `${await sideways(page)}px`);

    // ---- 2. Today at 390px: the same CV again asks, and attaching makes no second candidate
    const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const m = await phone.newPage();
    await m.addInitScript({ content: 'globalThis.__name = globalThis.__name || function (f) { return f; };' });
    await m.goto(`${BASE}/app/today`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(m);
    check(await m.locator('[data-candidate-drop-button]').isVisible(), 'at 390px the Add CV button is on Today');
    await dragFileOnto(m, cv);
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

    // ---- 3. The button's file picker, with a file that is not a candidate document
    await m.locator('[data-candidate-drop-panel] button', { hasText: 'Close' }).tap().catch(() => {});
    const notCv = '.cache/not-a-candidate-document.txt';
    fs.writeFileSync(notCv, 'Canteen menu for the week of 14 September: soup on Monday, fish on Friday. This is not a CV or a certificate.');
    await m.locator('[data-candidate-drop-input]').setInputFiles(notCv);
    check(await settled(m), 'at 390px a file chosen with the Add CV button is read');
    const rejected = await m.locator('[data-drop-result="rejected"]').first().innerText().catch(() => '');
    check(/Not saved/.test(rejected), 'at 390px a file that is not a candidate document is not saved, and the panel says so', rejected.replace(/\s+/g, ' '));
    check(await sideways(m) <= 1, 'at 390px nothing scrolls sideways', `${await sideways(m)}px`);
    fs.rmSync(notCv, { force: true });

    // ---- 4. Verify keeps its own drop zone
    await page.goto(`${BASE}/app/verify`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);
    const onVerify = await dragFileOnto(page, cv, false);
    check(onVerify === 0 && (await page.locator('[data-candidate-drop-button]').count()) === 0, "on Verify the overlay and the button stand aside for Verify's own drop zone");
    await phone.close();

    // ---- 5. metered
    const { data: cost } = await admin.from('cost_log').select('kind, eur, detail').eq('workspace_id', workspace).gte('created_at', startedAt);
    const kinds = [...new Set((cost ?? []).map((c: any) => c.kind))];
    check((cost ?? []).length > 0 && (cost ?? []).every((c: any) => String(c.detail).startsWith('test workspace')), 'every read was metered as test traffic', `${(cost ?? []).length} attempt(s) · ${kinds.join(', ')} · €${(cost ?? []).reduce((a: number, c: any) => a + Number(c.eur), 0).toFixed(4)}`);
  } finally {
    await browser.close();
    const leftBehind = await removeProbe(admin, uid, workspace, null, { clearContent: true });
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); } else console.log('\nprobe user, its workspace, candidate and documents removed');
  }
  console.log(failures === 0 ? 'candidate drop probe: all checks passed' : `candidate drop probe: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
