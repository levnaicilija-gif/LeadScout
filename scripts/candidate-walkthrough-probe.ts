/**
 * Item 24's closing walkthrough: the candidate CRM used the way a recruiter uses it, with nothing seeded and no step
 * taken by URL or by the database. Owner's instruction 2026-09-15: a test workspace, the sandblaster CV and test
 * certificate fixtures, client "Test Client Ltd", every real step.
 *
 *   npx tsx --env-file=.env.local scripts/candidate-walkthrough-probe.ts https://leadscout-rfbt.vercel.app
 *
 * Two throwaway recruiters, each in their own test workspace, so each run's CV makes a new candidate.
 *   1500px, mouse: sign in → drag the CV onto Home → Candidates from the rail → type a search → open the candidate →
 *     drag the certificate onto their page → View original → edit phone, preference and country, Save → log a CV sent to
 *     Test Client Ltd → type "sent to test client ltd" → Kanban → drag the card to Placed, fill client and date, Confirm
 *     → type "currently placed at test client ltd" → open them → Read CV → Download original → Generate the client
 *     version.
 *   390px, touch: sign in → Add CV → choose the file → Candidates from the navigation → type a search → open the
 *     candidate → tap the certificate zone, choose the file → log a CV sent → the stage menu to Placed, fill client and
 *     date, Confirm → Read CV → View original. The client version card is checked on screen, not run a second time.
 * The database is read only to confirm what a screen did. Every model call must be metered as test traffic. Both
 * accounts, their workspaces and everything they made are removed; a leftover fails the run.
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chromium, type Browser, type Page } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe } from '../src/lib/test-data';
import { candidateLabel } from '../src/lib/candidate-number';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const CV = 'fixtures/sandblaster-cv.docx';
const CERT = 'fixtures/test-certificate.pdf';
const CLIENT = 'Test Client Ltd';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const today = new Date().toISOString().slice(0, 10);
const shim = 'globalThis.__name = globalThis.__name || function (f) { return f; };';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };
const sideways = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const hydrated = (p: Page) => p.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', undefined, { timeout: 60000 }).catch(() => {});
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

type Account = { uid: string; workspace: string; email: string; password: string; name: string };

async function account(tag: string): Promise<Account> {
  const email = `candidate-walkthrough-${tag}+${Date.now()}@rfbt-recruitment.com`;
  const password = `probe-${Date.now()}-${tag}-0123456789`;
  const name = `Walkthrough Recruiter ${tag}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name, agency: `Walkthrough ${tag}` } });
  if (error) throw new Error(`could not create the ${tag} account: ${error.message}`);
  const uid = data.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);
  await admin.from('users').update({ role: 'recruiter', onboarding_day: 30, name }).eq('id', uid);
  await followAllForProbe(admin, uid);
  return { uid, workspace, email, password, name };
}

async function signIn(p: Page, a: Account, touch: boolean) {
  await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.fill('input[type=email]', a.email);
  await p.fill('input[type=password]', a.password);
  const submit = p.locator('form button:not([type=button])');
  if (touch) await submit.tap(); else await submit.click();
  await p.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});
  await hydrated(p);
  check(/\/app\//.test(p.url()), `${touch ? '390px' : '1500px'}: signed in through the login form`, p.url().replace(BASE, ''));
}

/** A file dragged in from the desktop: a DataTransfer carrying the fixture. */
async function fileTransfer(p: Page, file: string, type: string) {
  return p.evaluateHandle(({ b64, name, type }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const t = new DataTransfer(); t.items.add(new File([bytes], name, { type })); return t;
  }, { b64: fs.readFileSync(file).toString('base64'), name: file.split('/').pop()!, type });
}

const dropSettled = (p: Page) => p.waitForFunction(() => document.querySelector('[data-candidate-drop-panel]')?.getAttribute('data-candidate-drop-busy') === 'false'
  && !!document.querySelector('[data-drop-result], [data-candidate-drop-panel] .text-bad'), undefined, { timeout: 180000 }).then(() => true).catch(() => false);
const docSettled = (p: Page) => p.waitForFunction(() => document.querySelector('[data-candidate-doc-drop]')?.getAttribute('data-candidate-doc-busy') === 'false'
  && !!document.querySelector('[data-candidate-doc-result], [data-candidate-doc-added]'), undefined, { timeout: 180000 }).then(() => true).catch(() => false);

/** Type into the Candidates search box and press Enter; the ids of the rows or cards on screen. */
async function typeSearch(p: Page, q: string) {
  const box = p.locator('[data-candidate-search]');
  await box.fill(q);
  await box.press('Enter');
  await p.waitForURL((u) => new URL(u).searchParams.get('q') === q, { timeout: 60000 }).catch(() => {});
  await hydrated(p);
  return p.locator('[data-candidate-row], [data-kanban-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-candidate-row') ?? e.getAttribute('data-kanban-card')));
}

async function openCandidate(p: Page, id: string, touch: boolean) {
  if (!(await p.locator(`[data-candidate-link="${id}"]`).count())) {
    const table = p.locator('[data-view-toggle] a', { hasText: 'Table' });
    if (touch) await table.tap(); else await table.click();
    await p.waitForURL((u) => new URL(u).searchParams.get('view') !== 'kanban', { timeout: 60000 }).catch(() => {});
    await hydrated(p);
  }
  const link = p.locator(`[data-candidate-link="${id}"]`).first();
  if (touch) await link.tap(); else await link.click();
  await p.waitForURL(new RegExp(`/app/candidates/${id}$`), { timeout: 60000 }).catch(() => {});
  await hydrated(p);
  await p.waitForFunction(() => !/Reading the code…/i.test(document.body.innerText), undefined, { timeout: 30000 }).catch(() => {});
}

/** The rail or the phone navigation's Candidates link — whichever is on screen. */
async function goToCandidates(p: Page, touch: boolean, label: string) {
  const link = p.locator('a[href="/app/candidates"]:visible').first();
  const found = (await link.count()) > 0;
  check(found, `${label}: Candidates is reachable from the navigation`);
  if (found) { if (touch) await link.tap(); else await link.click(); }
  else await p.goto(`${BASE}/app/candidates`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForURL(/\/app\/candidates(\?|$)/, { timeout: 60000 }).catch(() => {});
  await hydrated(p);
}

async function theCandidate(a: Account) {
  const { data } = await admin.from('candidates').select('id, reference_code, full_name, stage').eq('workspace_id', a.workspace);
  return data ?? [];
}

async function checkPlacement(p: Page, a: Account, id: string, label: string) {
  let placed: any[] = [];
  for (let i = 0; i < 20 && !placed.length; i++) {
    ({ data: placed } = await admin.from('candidate_placements').select('client_name, placed_on, ended_on, placed_by, placed_at').eq('candidate_id', id) as any);
    placed = placed ?? [];
    if (!placed.length) await p.waitForTimeout(500);
  }
  const { data: c } = await admin.from('candidates').select('stage, stage_changed_by').eq('id', id).single();
  check(placed.length === 1 && placed[0].client_name === CLIENT && placed[0].placed_on === today && placed[0].ended_on === null && placed[0].placed_by === a.uid && !!placed[0].placed_at && c?.stage === 'placed' && c.stage_changed_by === a.uid,
    `${label}: Placed is recorded — ${CLIENT}, today, placed_by and placed_at — and the stage is Placed, moved by this recruiter`, JSON.stringify({ placed, stage: c }));
}

async function desktop(browser: Browser, a: Account) {
  console.log('\n1500px, mouse');
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.addInitScript({ content: shim });
  await signIn(page, a, false);

  // Drop the CV
  await page.goto(`${BASE}/app/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await hydrated(page);
  const cvDrag = await fileTransfer(page, CV, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  await page.dispatchEvent('main, body', 'dragenter', { dataTransfer: cvDrag });
  await page.dispatchEvent('main, body', 'dragover', { dataTransfer: cvDrag });
  check((await page.locator('[data-candidate-drop-overlay]').count()) > 0, '1500px: dragging a CV over Home shows the drop overlay');
  await page.dispatchEvent('main, body', 'drop', { dataTransfer: cvDrag });
  const cvDone = await dropSettled(page);
  const created = flat(await page.locator('[data-drop-result="created"]').first().innerText().catch(() => ''));
  const cands = await theCandidate(a);
  const cand = cands[0];
  check(cvDone && cands.length === 1 && !!cand?.reference_code && created.includes(candidateLabel(cand.reference_code)), '1500px: the dropped CV creates one candidate, and the result names their number', `${cands.length} candidate(s) · ${created.slice(0, 120)}`);
  if (!cand) throw new Error('no candidate was created, so the walkthrough cannot go on');
  const label = candidateLabel(cand.reference_code);
  const n = label.slice(1);
  await page.locator('[data-candidate-drop-panel] button', { hasText: 'Close' }).click().catch(() => {});

  // Find them
  await goToCandidates(page, false, '1500px');
  const byName = await typeSearch(page, `"${cand.full_name}"`);
  const understood = flat(await page.locator('[data-search-understood]').innerText().catch(() => ''));
  check(byName.length === 1 && byName[0] === cand.id, '1500px: typing their name in the search box finds exactly them', `${byName.length} found · ${understood}`);
  await openCandidate(page, cand.id, false);
  const header = flat(await page.locator('[data-candidate-header]').innerText().catch(() => ''));
  check(page.url().endsWith(`/app/candidates/${cand.id}`) && header.includes(label) && header.includes(cand.reference_code), '1500px: the row opens their page, headed by the number and the code', header.slice(0, 120));

  // Drop the certificate on their page
  const certDrag = await fileTransfer(page, CERT, 'application/pdf');
  await page.dispatchEvent('[data-candidate-doc-drop]', 'dragover', { dataTransfer: certDrag });
  await page.dispatchEvent('[data-candidate-doc-drop]', 'drop', { dataTransfer: certDrag });
  const certDone = await docSettled(page);
  // The specimen names Dragan Veselinović, not the sandblaster: their page asks, and the recruiter attaches it anyway.
  const certAsked = flat(await page.locator('[data-mismatch-question]').first().innerText().catch(() => ''));
  check(/This certificate is for .+ — this candidate is /.test(certAsked), '1500px: the certificate names someone else, so their page asks before attaching', certAsked.slice(0, 160));
  await page.locator('[data-mismatch-attach]').first().click();
  await page.waitForSelector('[data-candidate-certificate]', { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => !/Reading the code…/i.test(document.body.innerText), undefined, { timeout: 30000 }).catch(() => {});
  const certResult = flat(await page.locator('[data-candidate-certificate]').first().innerText().catch(() => ''));
  const { data: certs } = await admin.from('documents').select('id, candidate_id, verifications(state, valid_until)').eq('workspace_id', a.workspace).eq('type', 'certificate');
  check(certDone && (certs ?? []).length === 1 && certs![0].candidate_id === cand.id && (certs![0].verifications as any[]).length === 1,
    '1500px: "Attach anyway" puts the certificate dragged onto their page on them, checked with its issuer', JSON.stringify(certs?.map((c: any) => ({ mine: c.candidate_id === cand.id, verifications: c.verifications }))));
  check(/what the document says/i.test(certResult) && /confirmation/i.test(certResult), '1500px: the result shows what the document says and the confirmation', certResult.slice(0, 160));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await hydrated(page);
  check((await page.locator('[data-candidate-certificate]').count()) === 1, '1500px: after a reload the certificate is on their page');

  // View original
  await page.locator('[data-view-original]').first().click();
  await page.waitForURL(/\/documents\//, { timeout: 60000 }).catch(() => {});
  await hydrated(page);
  const src = await page.locator('[data-original] iframe, [data-original] img').first().getAttribute('src').catch(() => null);
  const file = src ? await page.request.get(`${BASE}${src}`, { maxRedirects: 5 }) : null;
  const decoded = flat(await page.locator('[data-decoded]').innerText().catch(() => ''));
  check(file?.status() === 200 && /pdf/.test(file.headers()['content-type'] ?? '') && /what the document says/i.test(decoded), '1500px: View original shows the uploaded PDF beside its reading', `HTTP ${file?.status()} · ${file?.headers()['content-type']}`);
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await hydrated(page);

  // Edit details
  await page.locator('[data-edit-field="phone"] input').fill('+47 912 34 567');
  await page.locator('[data-edit-field="employment_preference"] select').selectOption('contract');
  await page.locator('[data-edit-field="country"] input').fill('Norway');
  await page.locator('[data-edit-save]').click();
  await page.waitForFunction(() => !!document.querySelector('[data-edit-message]'), undefined, { timeout: 30000 }).catch(() => {});
  const saved = await page.locator('[data-edit-message]').innerText().catch(() => '');
  const { data: edited } = await admin.from('candidates').select('phone, employment_preference, country').eq('id', cand.id).single();
  check(saved === 'Saved' && edited?.phone === '+47 912 34 567' && edited.employment_preference === 'contract' && edited.country === 'Norway', '1500px: editing phone, preference and country and pressing Save stores them', `${saved} · ${JSON.stringify(edited)}`);

  // Log a CV sent
  await page.locator('[data-cv-sent-client]').fill(CLIENT);
  await page.locator('[data-cv-sent-date]').fill(today);
  await page.locator('[data-cv-sent-add]').click();
  await page.waitForFunction((client) => (document.querySelector('[data-cv-sent-log]')?.textContent ?? '').includes(client) && !!document.querySelector('[data-cv-sent-entry]'), CLIENT, { timeout: 30000 }).catch(() => {});
  const { data: sent } = await admin.from('sends').select('client_name, sent_by, sent_at').eq('candidate_id', cand.id);
  check((sent ?? []).length === 1 && sent![0].client_name === CLIENT && sent![0].sent_by === a.uid && String(sent![0].sent_at).startsWith(today), `1500px: logging a CV sent to ${CLIENT} records the client, who and when, and shows it on the page`, JSON.stringify(sent));

  // Search by client history
  await goToCandidates(page, false, '1500px');
  const bySend = await typeSearch(page, `"sent to ${CLIENT.toLowerCase()}"`);
  check(bySend.length === 1 && bySend[0] === cand.id, `1500px: typing "sent to ${CLIENT.toLowerCase()}" finds exactly them`, `${bySend.length} found`);

  // Kanban: drag to Placed
  await page.locator('[data-view-toggle] a', { hasText: 'Kanban' }).click();
  await page.waitForURL((u) => new URL(u).searchParams.get('view') === 'kanban', { timeout: 60000 }).catch(() => {});
  await hydrated(page);
  await page.locator(`[data-kanban-card="${cand.id}"]`).dragTo(page.locator('[data-kanban-column="placed"]'));
  const dialog = page.locator('[data-stage-dialog="placement"]');
  check(await dialog.isVisible().catch(() => false), '1500px: dragging their card to Placed asks for the client and the date');
  await page.fill('[data-placement-client]', CLIENT);
  await page.fill('[data-placement-date]', today);
  await page.click('[data-stage-confirm]');
  await page.waitForSelector('[data-stage-dialog]', { state: 'detached', timeout: 30000 }).catch(() => {});
  await checkPlacement(page, a, cand.id, '1500px');
  await hydrated(page);
  const inPlaced = await page.locator('[data-kanban-column="placed"] [data-kanban-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kanban-card')));
  check(inPlaced.includes(cand.id), '1500px: their card is in the Placed column');
  check(await sideways(page) <= 1, '1500px: the kanban does not scroll the page sideways', `${await sideways(page)}px`);

  // Search by placement, open them
  const byPlacement = await typeSearch(page, `"currently placed at ${CLIENT.toLowerCase()}"`);
  check(byPlacement.length === 1 && byPlacement[0] === cand.id, `1500px: typing "currently placed at ${CLIENT.toLowerCase()}" finds exactly them`, `${byPlacement.length} found`);
  await openCandidate(page, cand.id, false);
  const placements = flat(await page.locator('[data-candidate-section="placements"]').innerText().catch(() => ''));
  check(placements.includes(`${CLIENT} · from ${today} · current`) && placements.includes(`entered by ${a.name}`), '1500px: their page shows the current placement and who entered it', placements.slice(0, 160));

  // Read CV, download the original
  await page.locator('[data-read-cv]').click();
  await page.waitForURL(/\/cv$/, { timeout: 60000 }).catch(() => {});
  await hydrated(page);
  const sections = await page.locator('[data-cv-section]').evaluateAll((els) => els.map((e) => e.getAttribute('data-cv-section')));
  check(['contact', 'certifications', 'work-history', 'skills'].every((s) => sections.includes(s)), '1500px: Read CV opens the standard reading view', sections.join(', '));
  const href = await page.locator('[data-cv-download]').getAttribute('href');
  const dl = await page.request.get(`${BASE}${href}`, { maxRedirects: 5 });
  const disposition = dl.headers()['content-disposition'] ?? '';
  check(dl.status() === 200 && (await dl.body()).length === fs.statSync(CV).size && new RegExp(`candidate-${n}-cv\\.docx`).test(disposition) && !/marian/i.test(disposition),
    '1500px: Download original returns the file that was dropped, named by number and type', `HTTP ${dl.status()} · ${(await dl.body()).length} bytes · ${disposition}`);
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await hydrated(page);

  // Client version
  await page.locator('[data-anonymize-run]').click();
  const anonDone = await page.waitForSelector('[data-anonymize-result], [data-anonymize-error]', { timeout: 240000 }).then(() => true).catch(() => false);
  const state = await page.locator('[data-anonymize-result]').getAttribute('data-anonymize-result').catch(() => null);
  const anonError = flat(await page.locator('[data-anonymize-error]').innerText().catch(() => ''));
  const { data: anon } = await admin.from('anonymized_cvs').select('pii_check_passed, storage_path').eq('candidate_id', cand.id);
  check(anonDone && !!state && (anon ?? []).length === 1 && anon![0].pii_check_passed === (state === 'passed'), '1500px: Generate client version runs for them and says whether the PII check passed', `${state ?? anonError} · ${JSON.stringify(anon)}`);
  check(await sideways(page) <= 1, '1500px: their page does not scroll sideways', `${await sideways(page)}px`);
  await page.close();
}

async function phone(browser: Browser, a: Account) {
  console.log('\n390px, touch');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const m = await ctx.newPage();
  await m.addInitScript({ content: shim });
  try {
    await signIn(m, a, true);

    // Add CV
    const addCv = m.locator('[data-candidate-drop-button]');
    check(await addCv.isVisible().catch(() => false), '390px: the Add CV button is on screen');
    const [cvChooser] = await Promise.all([m.waitForEvent('filechooser', { timeout: 30000 }), addCv.tap()]);
    await cvChooser.setFiles(CV);
    const cvDone = await dropSettled(m);
    const cands = await theCandidate(a);
    const cand = cands[0];
    check(cvDone && cands.length === 1 && !!cand?.reference_code, '390px: Add CV and choosing the file creates one candidate', `${cands.length} candidate(s)`);
    if (!cand) throw new Error('no candidate was created on the phone, so the walkthrough cannot go on');
    check(await sideways(m) <= 1, '390px: the result panel does not scroll the page sideways', `${await sideways(m)}px`);
    await m.locator('[data-candidate-drop-panel] button', { hasText: 'Close' }).tap().catch(() => {});

    // Find and open them
    await goToCandidates(m, true, '390px');
    const byName = await typeSearch(m, `"${cand.full_name}"`);
    check(byName.length === 1 && byName[0] === cand.id, '390px: typing their name finds exactly them', `${byName.length} found`);
    await openCandidate(m, cand.id, true);
    check(m.url().endsWith(`/app/candidates/${cand.id}`) && await sideways(m) <= 1, '390px: tapping the row opens their page, which does not scroll sideways', `${await sideways(m)}px`);

    // Certificate from the file picker
    const [certChooser] = await Promise.all([m.waitForEvent('filechooser', { timeout: 30000 }), m.locator('[data-candidate-doc-drop]').tap()]);
    await certChooser.setFiles(CERT);
    const certDone = await docSettled(m);
    await m.locator('[data-mismatch-attach]').first().tap().catch(() => {});
    await m.waitForSelector('[data-candidate-doc-added]', { timeout: 30000 }).catch(() => {});
    const { data: certs } = await admin.from('documents').select('candidate_id, verifications(state)').eq('workspace_id', a.workspace).eq('type', 'certificate');
    check(certDone && (certs ?? []).length === 1 && certs![0].candidate_id === cand.id && (certs![0].verifications as any[]).length === 1, '390px: the certificate chosen through their zone asks, and "Attach anyway" puts it on them, checked', JSON.stringify(certs));
    check(await sideways(m) <= 1, '390px: the certificate result does not scroll the page sideways', `${await sideways(m)}px`);

    // CV sent
    await m.locator('[data-cv-sent-client]').fill(CLIENT);
    await m.locator('[data-cv-sent-date]').fill(today);
    await m.locator('[data-cv-sent-add]').tap();
    await m.waitForFunction((client) => (document.querySelector('[data-cv-sent-log]')?.textContent ?? '').includes(client) && !!document.querySelector('[data-cv-sent-entry]'), CLIENT, { timeout: 30000 }).catch(() => {});
    const { data: sent } = await admin.from('sends').select('client_name, sent_by, sent_at').eq('candidate_id', cand.id);
    check((sent ?? []).length === 1 && sent![0].client_name === CLIENT && sent![0].sent_by === a.uid, `390px: logging a CV sent to ${CLIENT} records the client and who`, JSON.stringify(sent));

    // Placed through the stage menu (a phone cannot drag)
    await m.locator(`[data-stage-select="${cand.id}"]`).first().selectOption('placed');
    check(await m.locator('[data-stage-dialog="placement"]').isVisible().catch(() => false), '390px: choosing Placed in the stage menu asks for the client and the date');
    await m.fill('[data-placement-client]', CLIENT);
    await m.fill('[data-placement-date]', today);
    await m.locator('[data-stage-confirm]').tap();
    await m.waitForSelector('[data-stage-dialog]', { state: 'detached', timeout: 30000 }).catch(() => {});
    await checkPlacement(m, a, cand.id, '390px');
    await m.waitForFunction((client) => (document.querySelector('[data-candidate-section="placements"]')?.textContent ?? '').includes(client), CLIENT, { timeout: 30000 }).catch(() => {});
    const placements = flat(await m.locator('[data-candidate-section="placements"]').innerText().catch(() => ''));
    check(placements.includes(`${CLIENT} · from ${today} · current`), '390px: their page shows the current placement', placements.slice(0, 120));

    // Client version card, Read CV, View original
    check(await m.locator('[data-anonymize-run]').isVisible().catch(() => false), '390px: the client version card is on their page');
    await m.locator('[data-read-cv]').tap();
    await m.waitForURL(/\/cv$/, { timeout: 60000 }).catch(() => {});
    await hydrated(m);
    check((await m.locator('[data-cv-section]').count()) >= 4 && await sideways(m) <= 1, '390px: Read CV opens the reading view without sideways scroll', `${await sideways(m)}px`);
    await m.goBack({ waitUntil: 'domcontentloaded' });
    await hydrated(m);
    await m.locator('[data-view-original]').first().tap();
    await m.waitForURL(/\/documents\//, { timeout: 60000 }).catch(() => {});
    await hydrated(m);
    check((await m.locator('[data-original]').count()) === 1 && await sideways(m) <= 1, '390px: View original shows the original and its reading stacked, without sideways scroll', `${await sideways(m)}px`);
  } finally {
    await ctx.close();
  }
}

(async () => {
  for (const f of [CV, CERT]) if (!fs.existsSync(f)) { console.error(`${f} is not on this machine`); process.exit(1); }
  const startedAt = new Date().toISOString();
  const accounts: Account[] = [];
  const browser = await chromium.launch();
  try {
    for (const [tag, walk] of [['desk', desktop], ['phone', phone]] as const) {
      try {
        const a = await account(tag);
        accounts.push(a);
        await walk(browser, a);
      } catch (e: any) {
        check(false, `the ${tag} walkthrough ran to the end`, String(e?.message ?? e).slice(0, 300));
      }
    }
    if (accounts.length) {
      const { data: cost } = await admin.from('cost_log').select('kind, eur, detail, workspace_id').in('workspace_id', accounts.map((a) => a.workspace)).gte('created_at', startedAt);
      const eur = (cost ?? []).reduce((s: number, c: any) => s + Number(c.eur ?? 0), 0);
      check((cost ?? []).length > 0 && (cost ?? []).every((c: any) => String(c.detail).startsWith('test workspace')), 'every model call was metered as test traffic, outside the €2.00 cap', `${(cost ?? []).length} attempt(s) · ${[...new Set((cost ?? []).map((c: any) => c.kind))].join(', ')} · €${eur.toFixed(4)}`);
    }
  } finally {
    await browser.close();
    for (const a of accounts) {
      const left = await removeProbe(admin, a.uid, a.workspace, null, { clearContent: true });
      if (left) { failures++; console.log(`  FAIL  cleanup — ${left}`); }
    }
    if (accounts.length) console.log('\nboth walkthrough accounts, their workspaces and everything they made removed');
  }
  console.log(failures === 0 ? 'candidate walkthrough: all checks passed' : `candidate walkthrough: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
