/**
 * Item 24 step 3 on screen: one candidate page — details, CV, certificates, CVs sent and placements together, no tabs —
 * as a signed-in recruiter at 1500px and at 390px on a touch screen.
 *
 *   npx tsx --env-file=.env.local scripts/candidate-page-probe.ts https://leadscout-rfbt.vercel.app
 *
 * In a throwaway test workspace it seeds one made-up candidate with a parsed CV profile and a FROSIO certificate with its
 * verification. Then:
 *   1. 1500px: the list links to the page; Details, CV, Certificates, CVs sent and Placements are all on it, with no tabs;
 *      the certificate shows its three layers (what the document says, what it means, the confirmation).
 *   2. An invalid phone is refused with its reason and nothing is saved; valid edits (name, phone, email, trade,
 *      availability, notes) are saved to the database. After a reload every field — the nine on the form with 0035 — shows
 *      what was saved, the header carries the new name, and a field cleared and saved is stored empty (item 24 follow-up
 *      3, step 6: confirm editing persists).
 *   3. With 0035: employment preference, based-in country and keep-until date save; logging a CV sent to Semco Maritime
 *      records client, sent_by and sent_at, and the list's search finds "sent to semco"; the page's stage picker records a
 *      placement at AIBEL, shown as current with who entered it.
 *   4. 390px: the page does not scroll sideways, and the edit form saves from a phone.
 *   With 0035 it also seeds a pack prepared for a lead with no sent date and nobody recorded — #9's McDermott row, which
 *   read "01/01/1970 · logged by —" on production — and checks at both widths that it reads as a pack with "date not
 *   recorded", never 1970, and that the list finds it as "pack for", never as "sent to" (src/lib/cv-sent-entry.ts).
 * Without 0035 the checks in 3 cannot run, and the probe fails saying so: step 3 is not confirmed without them.
 * Everything it made is removed afterwards; a leftover fails the run.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe, probeAdmin } from '../src/lib/test-data';
import { hasCandidateCrm } from '../src/lib/schema-features';
import { candidateLabel } from '../src/lib/candidate-number';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const EMAIL = `candidate-page-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = `probe-${Date.now()}-0123456789`;
const admin = probeAdmin();

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };
const sideways = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const hydrated = (p: Page) => p.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', undefined, { timeout: 60000 }).catch(() => {});
const today = new Date().toISOString().slice(0, 10);

async function saveForm(p: Page) {
  await p.locator('[data-edit-save]').click();
  await p.waitForFunction(() => !!document.querySelector('[data-edit-message]'), undefined, { timeout: 30000 }).catch(() => {});
  return p.locator('[data-edit-message]').innerText().catch(() => '');
}

(async () => {
  const crm = await hasCandidateCrm(admin);
  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Candidate Page Probe', agency: 'Candidate Page Probe' } });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);
  await admin.from('users').update({ role: 'recruiter', onboarding_day: 30 }).eq('id', uid);
  await followAllForProbe(admin, uid);

  const ref = `PROBE${Date.now().toString().slice(-5).replace(/\d/g, (d) => 'ABCDEFGHIJ'[Number(d)])}-P-9100`;
  const profile = { full_name: 'Probe Marko Jovanović', trade: 'Industrial painter / blaster', trade_code: 'P', trades: ['painter', 'blaster'], languages: ['English (B2)', 'Serbian (native)'], certificates_claimed: ['FROSIO Level III'], projects: [{ years: '2019-2024', type: 'blasting and painting of modules', country: 'Norway' }, { years: '2015-2018', type: 'shipyard painting', country: 'Poland' }], skills: [], pii: {} };
  const { data: cand, error: cErr } = await admin.from('candidates').insert({ workspace_id: workspace, reference_code: ref, trade_code: 'P', full_name: profile.full_name, trade: profile.trade, languages: profile.languages, profile, created_via: 'manual', created_by: uid, is_test: true, ...(crm ? { owner_id: uid } : {}) }).select('id').single();
  if (cErr) { console.error('seeding failed:', cErr.message); await removeProbe(admin, uid, workspace, null, { clearContent: true }); process.exit(1); }
  const { data: doc } = await admin.from('documents').insert({ candidate_id: cand!.id, workspace_id: workspace, type: 'certificate', cert_body: 'frosio', storage_path: `page-probe/${ref}`, extracted: { doc_type: 'certificate', cert_body: 'frosio', level: 'III', number: '12345', holder: profile.full_name, issued: '2021-03-01', expiry: '2026-03-01' }, is_test: true }).select('id').single();
  // A candidate made from a CV has the CV as a document (intake stores it); the page's CV section reads the profile beside it.
  await admin.from('documents').insert({ candidate_id: cand!.id, workspace_id: workspace, type: 'cv', storage_path: `page-probe/${ref}-cv`, extracted: { doc_type: 'cv' }, is_test: true });
  await admin.from('verifications').insert({ document_id: doc!.id, method: 'manual', result: 'valid', valid_until: '2026-03-01', state: 'verified_credential', checked_at: new Date().toISOString(), checked_where: 'https://www.credential.net/' });
  // A pack prepared for a lead: sent_at null by design, and sent_by null as send-pack wrote it before 2026-09-15.
  const { data: pack } = crm
    ? await admin.from('sends').insert({ candidate_id: cand!.id, client_name: 'Probe Pack Client', sent_at: null, sent_by: null }).select('id').single()
    : { data: null };

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || function (f) { return f; };' });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});

    // ---- 1. from the list to one page
    await page.goto(`${BASE}/app/candidates`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);
    await page.locator(`[data-candidate-link="${cand!.id}"]`).click();
    await page.waitForURL(new RegExp(`/app/candidates/${cand!.id}`), { timeout: 60000 }).catch(() => {});
    await hydrated(page);
    await page.waitForFunction(() => !/Reading the code…/i.test(document.body.innerText), undefined, { timeout: 30000 }).catch(() => {});
    const sections = await page.locator('[data-candidate-section]').evaluateAll((els) => els.map((e) => e.getAttribute('data-candidate-section')));
    const header = await page.locator('[data-candidate-header]').innerText().catch(() => '');
    check(page.url().includes(cand!.id) && header.includes(candidateLabel(ref)) && header.includes(ref), 'the list opens the candidate page, headed by #N and the code', header.replace(/\s+/g, ' ').slice(0, 120));
    check(['details', 'cv-sent', 'placements', 'cv', 'certificates'].every((s) => sections.includes(s)) && (await page.locator('[role="tab"], [role="tablist"]').count()) === 0, 'details, CVs sent, placements, CV and certificates are on one page, with no tabs', sections.join(', '));
    const certText = (await page.locator(`[data-candidate-certificate="${doc!.id}"]`).innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(/what the document says/i.test(certText) && /what this certificate means/i.test(certText) && /confirmation/i.test(certText) && /verified via credential link/i.test(certText), 'the certificate shows all three layers and its confirmation', certText.slice(0, 200));
    const cvText = await page.locator('[data-candidate-section="cv"]').innerText().catch(() => '');
    check(/Industrial painter/.test(cvText) && /2 periods on the CV/.test(cvText) && /FROSIO Level III/.test(cvText), 'the CV section reads the parsed profile', cvText.replace(/\s+/g, ' ').slice(0, 200));
    check(await sideways(page) <= 1, 'at 1500px the page does not scroll sideways', `${await sideways(page)}px`);
    if (crm) {
      const logText = (await page.locator('[data-cv-sent-log]').innerText().catch(() => '')).replace(/\s+/g, ' ');
      check(!!pack && (await page.locator('[data-cv-sent-entry="pack"]').count()) === 1 && /Probe Pack Client · pack prepared for a lead, not marked sent/.test(logText)
        && /date not recorded · prepared by not recorded/.test(logText) && !/1970/.test(logText),
      'at 1500px a pack with no sent date reads "pack prepared", "date not recorded", "prepared by not recorded" — never 01/01/1970', logText.slice(0, 200));
    }

    // ---- 2. edits: refused with a reason, then saved
    await page.locator('[data-edit-field="phone"] input').fill('call me');
    const refused = await saveForm(page);
    const problem = await page.locator('[data-edit-problem="phone"]').innerText().catch(() => '');
    const { data: before } = await admin.from('candidates').select('phone').eq('id', cand!.id).single();
    check(/not saved/i.test(refused) && /only digits/.test(problem) && before?.phone == null, 'an invalid phone is refused with its reason, and nothing is saved', `${refused} · ${problem}`);
    await page.locator('[data-edit-field="full_name"] input').fill('Probe Marko Jovanović-Edited');
    await page.locator('[data-edit-field="phone"] input').fill('+47 912 34 567');
    await page.locator('[data-edit-field="email"] input').fill('probe.marko@example.com');
    await page.locator('[data-edit-field="trade"] input').fill('Painter / blaster');
    await page.locator('[data-edit-field="availability_from"] input').fill('2026-10-01');
    await page.locator('[data-edit-field="notes"] textarea').fill('Probe note: prefers 8:2 rotation.');
    if (crm) {
      await page.locator('[data-edit-field="employment_preference"] select').selectOption('contract');
      await page.locator('[data-edit-field="country"] input').fill('Norway');
      await page.locator('[data-edit-field="data_retention_until"] input').fill('2028-09-15');
    }
    const saved = await saveForm(page);
    const { data: after } = await admin.from('candidates').select(`full_name, phone, email, trade, availability_from, internal_notes${crm ? ', employment_preference, country, data_retention_until' : ''}` as '*').eq('id', cand!.id).single() as { data: any };
    check(saved === 'Saved' && after?.full_name === 'Probe Marko Jovanović-Edited' && after.phone === '+47 912 34 567' && after.email === 'probe.marko@example.com' && after.trade === 'Painter / blaster' && after.availability_from === '2026-10-01' && after.internal_notes === 'Probe note: prefers 8:2 rotation.', 'valid edits are saved: name, phone, email, trade, availability, notes', JSON.stringify(after));

    // Step 6: what the form shows after a reload is what the database holds — every field, not only the ones checked above.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await hydrated(page);
    const shown = await page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('[data-edit-field]')).map((f) => [f.getAttribute('data-edit-field'), (f.querySelector('input, textarea, select') as HTMLInputElement | null)?.value ?? null])));
    const want: Record<string, string> = {
      full_name: 'Probe Marko Jovanović-Edited', phone: '+47 912 34 567', email: 'probe.marko@example.com', trade: 'Painter / blaster',
      availability_from: '2026-10-01', notes: 'Probe note: prefers 8:2 rotation.',
      ...(crm ? { employment_preference: 'contract', country: 'Norway', data_retention_until: '2028-09-15' } : {}),
    };
    const wrong = Object.entries(want).filter(([k, v]) => shown[k] !== v);
    check(wrong.length === 0 && Object.keys(shown).length === Object.keys(want).length, `after a reload all ${Object.keys(want).length} fields on the form show what was saved`, wrong.length ? JSON.stringify(Object.fromEntries(wrong.map(([k]) => [k, shown[k]]))) : Object.keys(shown).join(', '));
    check(/Probe Marko Jovanović-Edited/.test(await page.locator('[data-candidate-header]').innerText().catch(() => '')), 'the page header carries the edited name');
    await page.locator('[data-edit-field="trade"] input').fill('');
    await page.locator('[data-edit-save]').click();
    let clearedTrade: unknown = 'not read';
    for (let i = 0; i < 30; i++) {                       // waits for the stored value, not for a fixed time
      clearedTrade = (await admin.from('candidates').select('trade').eq('id', cand!.id).single()).data?.trade;
      if (clearedTrade === null) break;
      await page.waitForTimeout(500);
    }
    check(clearedTrade === null, 'a field cleared and saved is stored empty, not left as it was', JSON.stringify({ trade: clearedTrade }));

    // ---- 3. with 0035: preference, CV sent, placement
    if (!crm) {
      check(false, '0035 is not applied, so employment preference, CV sent and placement could not be checked — step 3 is not confirmed without them');
    } else {
      check(after.employment_preference === 'contract' && after.country === 'Norway' && after.data_retention_until === '2028-09-15', 'employment preference, based-in country and keep-until date are saved', JSON.stringify(after));
      await page.locator('[data-cv-sent-client]').fill('Semco Maritime');
      await page.locator('[data-cv-sent-date]').fill(today);
      await page.locator('[data-cv-sent-add]').click();
      await page.waitForFunction(() => /Semco Maritime/.test(document.querySelector('[data-cv-sent-log]')?.textContent ?? '') && !!document.querySelector('[data-cv-sent-entry]'), undefined, { timeout: 30000 }).catch(() => {});
      const { data: sent } = await admin.from('sends').select('client_name, sent_by, sent_at').eq('candidate_id', cand!.id).not('sent_at', 'is', null);
      check((sent ?? []).length === 1 && sent![0].client_name === 'Semco Maritime' && sent![0].sent_by === uid && String(sent![0].sent_at).startsWith(today), 'logging a CV sent records the client, who and when', JSON.stringify(sent));
      await page.goto(`${BASE}/app/candidates?q=${encodeURIComponent('"sent to semco"')}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      check((await page.locator(`[data-candidate-row="${cand!.id}"]`).count()) === 1, 'the list finds the candidate by the client their CV was sent to');
      await page.goto(`${BASE}/app/candidates?q=${encodeURIComponent('"sent to probe pack client"')}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const packAsSent = await page.locator(`[data-candidate-row="${cand!.id}"]`).count();
      await page.goto(`${BASE}/app/candidates?q=${encodeURIComponent('"pack for probe pack client"')}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const packFound = await page.locator(`[data-candidate-row="${cand!.id}"]`).count();
      // Column 8 of the table is "CV sent to".
      const sentCell = await page.locator(`[data-candidate-row="${cand!.id}"] td`).nth(7).innerText().catch(() => '');
      check(packAsSent === 0 && packFound === 1 && /Semco Maritime/.test(sentCell) && !/Probe Pack Client/.test(sentCell),
        'the pack is found as "pack for", never as "sent to", and "CV sent to" lists only the CV sent', `"sent to" matched ${packAsSent}, "pack for" matched ${packFound}, column "${sentCell}"`);

      await page.goto(`${BASE}/app/candidates/${cand!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(page);
      await page.selectOption(`[data-stage-select="${cand!.id}"]`, 'placed');
      await page.fill('[data-placement-client]', 'AIBEL');
      await page.fill('[data-placement-date]', today);
      await page.click('[data-stage-confirm]');
      await page.waitForSelector('[data-stage-dialog]', { state: 'detached', timeout: 30000 }).catch(() => {});
      await page.waitForFunction(() => /AIBEL/.test(document.querySelector('[data-candidate-section="placements"]')?.textContent ?? ''), undefined, { timeout: 30000 }).catch(() => {});
      const placementsText = (await page.locator('[data-candidate-section="placements"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
      const { data: placed } = await admin.from('candidate_placements').select('client_name, placed_on, ended_on, placed_by').eq('candidate_id', cand!.id);
      check((placed ?? []).length === 1 && placed![0].placed_by === uid && /AIBEL · from .* · current/.test(placementsText) && /entered by Candidate Page Probe/.test(placementsText), 'the page records a placement at AIBEL and shows it as current, with who entered it', placementsText.slice(0, 160));
    }

    // ---- 4. 390px
    const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const m = await phone.newPage();
    await m.addInitScript({ content: 'globalThis.__name = globalThis.__name || function (f) { return f; };' });
    await m.goto(`${BASE}/app/candidates/${cand!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(m);
    await m.waitForFunction(() => !/Reading the code…/i.test(document.body.innerText), undefined, { timeout: 30000 }).catch(() => {});
    check(await sideways(m) <= 1, 'at 390px the page does not scroll sideways', `${await sideways(m)}px`);
    if (crm) {
      const mLog = (await m.locator('[data-cv-sent-log]').innerText().catch(() => '')).replace(/\s+/g, ' ');
      check(/Probe Pack Client · pack prepared for a lead, not marked sent/.test(mLog) && /date not recorded/.test(mLog) && !/1970/.test(mLog), 'at 390px the pack reads the same, with no 1970', mLog.slice(0, 200));
    }
    await m.locator('[data-edit-field="notes"] textarea').fill('Probe note from a phone.');
    await m.locator('[data-edit-save]').tap();
    await m.waitForFunction(() => document.querySelector('[data-edit-message]')?.textContent === 'Saved', undefined, { timeout: 30000 }).catch(() => {});
    const { data: fromPhone } = await admin.from('candidates').select('internal_notes').eq('id', cand!.id).single();
    check(fromPhone?.internal_notes === 'Probe note from a phone.', 'at 390px the edit form saves', JSON.stringify(fromPhone));
    await phone.close();
  } finally {
    await browser.close();
    // The seeded pack recorded nobody, so removeProbe's delete by sent_by does not reach it.
    if (pack) await admin.from('sends').delete().eq('id', pack.id);
    const leftBehind = await removeProbe(admin, uid, workspace, null, { clearContent: true });
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); } else console.log('\nprobe user, its workspace and every seeded row removed');
  }
  console.log(failures === 0 ? 'candidate page probe: all checks passed' : `candidate page probe: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
