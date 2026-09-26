/**
 * Item 24 follow-up 3, steps 7 and 8 on screen: deleting a candidate completely, and the two ways a certificate leaves a
 * candidate. As a senior and a recruiter in one throwaway test workspace, at 1500px and at 390px on a touch screen.
 *
 *   npx tsx --env-file=.env.local scripts/candidate-delete-probe.ts https://leadscout-rfbt.vercel.app [--steps 7,8]
 *
 * Seeded, with real stored files: a candidate holding two CVs, three certificates (each with an issuer check, two with an
 * issuer screenshot), a client version and its PDF, a score, a CV sent and a pack prepared for a lead, a placement, a
 * campaign place and an internal download — every table that references a candidate — and a control candidate with a
 * certificate of their own. No model reads.
 *
 * Step 8:
 *   1. The recruiter: "Delete permanently" is disabled and says why; "Remove from this candidate" says nothing is deleted,
 *      and takes the certificate off — kept, attached to nobody, its issuer check kept, its file moved out of their folder.
 *   2. The recruiter's DELETE is refused (403), and the certificate is still there.
 *   3. The senior: "Delete permanently" says the file is erased and cannot be recovered and points at Remove instead; it
 *      stays disabled until "delete" is typed, then erases the row, its issuer check, its file and its screenshot, and the
 *      deletion log holds who and when with no name.
 *   4. The two boxes read differently, and at 390px the actions and the box fit the screen.
 * Step 7:
 *   5. Before: rows per table for the candidate, and their stored files.
 *   6. The recruiter sees "Only a senior can delete a candidate", and their DELETE is refused (403); a senior's DELETE
 *      with the wrong name is refused (400) and nothing changes.
 *   7. The senior's box lists what goes, keeps the button disabled until the name is typed (any case), and deletes.
 *   8. After: every table holds 0 rows for them, every one of their files is gone from documents, pdfs and screenshots,
 *      the control candidate and the certificate taken off them in step 8 are untouched, the list no longer shows them,
 *      and the deletion log holds the before and after counts, who and when — and not their name.
 *   9. At 390px the delete box fits the screen (opened on the control candidate, then cancelled).
 * Everything it made is removed afterwards; a leftover fails the run.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe, probeAdmin } from '../src/lib/test-data';
import { hasCandidateCrm } from '../src/lib/schema-features';
import { candidateIds, candidateRowCounts } from '../src/lib/candidate-deletion';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const stepsArg = process.argv.indexOf('--steps');
const STEPS = new Set((stepsArg > 0 ? process.argv[stepsArg + 1] : '7,8').split(',').map((s) => s.trim()));
const stamp = Date.now();
const NAME = 'Probe Delete Person';
const CONTROL = 'Probe Control Person';
const admin = probeAdmin();
const shim = 'globalThis.__name = globalThis.__name || function (f) { return f; };';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };
/** The same nine counts, whatever order the keys come back in: the log row has been through JSON storage. */
const sameCounts = (a: any, b: any) => {
  if (!a || !b) return false;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.every((k) => Number(a[k]) === Number(b[k]));
};
/**
 * Is this button readable? Its label must have text, and the text colour must differ from the colour behind it — a
 * destructive confirm was blank on 2026-09-16 (white on white: globals.css defines .btn after Tailwind's utilities, so
 * .btn's bg-panel beat bg-bad while text-white still applied).
 */
const readable = async (p: Page, selector: string) => p.evaluate((sel) => {
  const el = document.querySelector(sel) as HTMLElement | null;
  if (!el) return { found: false, text: '', colour: '', behind: '', legible: false };
  const style = getComputedStyle(el);
  const colour = style.color;
  let behind = style.backgroundColor;
  let up: HTMLElement | null = el;
  while (up && (behind === 'rgba(0, 0, 0, 0)' || behind === 'transparent')) { up = up.parentElement; behind = up ? getComputedStyle(up).backgroundColor : 'rgb(255, 255, 255)'; }
  const text = (el.textContent ?? '').trim();
  return { found: true, text, colour, behind, legible: text.length > 0 && colour !== behind };
}, selector);

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const hydrated = (p: Page) => p.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', undefined, { timeout: 60000 }).catch(() => {});
const sideways = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const must = (r: { data: any; error: any }, what: string): any => { if (r.error || r.data == null) throw new Error('seeding ' + what + ' failed: ' + (r.error?.message ?? 'no row')); return r.data; };
// Whether a stored object is really there. Asked with list(), never download(): a download of a path fetched earlier in
// the same run comes back from a cache and says "present" after the object has gone (2026-09-16).
const exists = async (bucket: string, path: string) => {
  const cut = path.lastIndexOf('/');
  const folder = cut < 0 ? '' : path.slice(0, cut);
  const name = cut < 0 ? path : path.slice(cut + 1);
  const { data, error } = await admin.storage.from(bucket).list(folder);
  if (error) throw new Error(`listing ${bucket}/${folder}: ${error.message}`);
  return (data ?? []).some((o: any) => o.name === name);
};
const put = async (bucket: string, path: string, type: string) => {
  const { error } = await admin.storage.from(bucket).upload(path, Buffer.from(`probe file ${path}`), { contentType: type, upsert: true });
  if (error) throw new Error(`uploading ${bucket}/${path} failed: ${error.message}`);
};
const code = (n: string) => `PROBE${String(stamp).slice(-5).replace(/\d/g, (d) => 'ABCDEFGHIJ'[Number(d)])}-P-${n}`;

async function account(label: string) {
  const email = `candidate-delete-probe-${label}+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: `Delete Probe ${label}`, agency: 'Candidate Delete Probe' } });
  if (error) throw new Error(`could not create the ${label}: ${error.message}`);
  const uid = data.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  await markWorkspaceTest(admin, me?.workspace_id);
  await followAllForProbe(admin, uid);
  return { uid, email, password, ownWorkspace: me?.workspace_id as string };
}

async function signIn(p: Page, a: { email: string; password: string }) {
  await p.addInitScript({ content: shim });
  await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.fill('input[type=email]', a.email);
  await p.fill('input[type=password]', a.password);
  await p.click('form button:not([type=button])');
  await p.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});
}

(async () => {
  const crm = await hasCandidateCrm(admin);
  const senior = await account('senior');
  const recruiter = await account('recruiter');
  const W = senior.ownWorkspace;
  await admin.from('users').update({ role: 'senior', onboarding_day: 30 }).eq('id', senior.uid);
  await admin.from('users').update({ role: 'recruiter', onboarding_day: 30, workspace_id: W }).eq('id', recruiter.uid);
  const files: { bucket: string; path: string }[] = [];
  let campaignId: string | null = null;

  const browser = await chromium.launch();
  try {
    // ---------------------------------------------------------------- seed
    const person = async (name: string, ref: string) => must(await admin.from('candidates').insert({
      workspace_id: W, reference_code: ref, trade_code: 'P', full_name: name, trade: 'Painter', profile: { full_name: name, trade: 'Painter', pii: {} },
      created_via: 'manual', created_by: senior.uid, is_test: true, ...(crm ? { owner_id: senior.uid } : {}),
    }).select('id').single(), name).id as string;
    const T = await person(NAME, code('9112'));
    const K = await person(CONTROL, code('9113'));
    const doc = async (candidateId: string, type: 'cv' | 'certificate', label: string, name: string) => {
      const path = `${W}/${type}/${candidateId}/probe-${label}.pdf`;
      await put('documents', path, 'application/pdf');
      files.push({ bucket: 'documents', path });
      const extracted = type === 'cv' ? { doc_type: 'cv', holder: name, profile: { full_name: name, trade: 'Painter', pii: {} } } : { doc_type: 'certificate', holder: name, number: `SPECIMEN-${label}`, level: 'III', cert_body: 'frosio' };
      const id = must(await admin.from('documents').insert({ workspace_id: W, candidate_id: candidateId, type, cert_body: type === 'certificate' ? 'frosio' : null, storage_path: path, extracted, uploaded_by: senior.uid, is_test: true }).select('id').single(), `document ${label}`).id as string;
      if (type === 'certificate') must(await admin.from('verifications').insert({ document_id: id, method: 'manual', result: 'valid', state: 'verified_credential', valid_until: '2027-01-01', checked_at: new Date().toISOString() }).select('id').single(), `verification ${label}`);
      return { id, path };
    };
    const cvA = await doc(T, 'cv', 'cv-a', NAME);
    const cvB = await doc(T, 'cv', 'cv-b', NAME);
    const c1 = await doc(T, 'certificate', 'c1', NAME);
    const c2 = await doc(T, 'certificate', 'c2', NAME);
    const c3 = await doc(T, 'certificate', 'c3', NAME);
    const kc = await doc(K, 'certificate', 'k', CONTROL);
    for (const c of [c2, c3]) { const p = `${W}/verify/${c.id}.png`; await put('screenshots', p, 'image/png'); files.push({ bucket: 'screenshots', path: p }); }
    const pdfPath = `probe-delete/${code('9112')}.pdf`;
    await put('pdfs', pdfPath, 'application/pdf');
    files.push({ bucket: 'pdfs', path: pdfPath });
    const anon = must(await admin.from('anonymized_cvs').insert({ candidate_id: T, storage_path: pdfPath, public_slug: `probe-delete-${stamp}`, pii_check_passed: true }).select('id').single(), 'client version').id;
    const score = must(await admin.from('scores').insert({ candidate_id: T, score: 70 }).select('id').single(), 'score').id;
    must(await admin.from('sends').insert([
      { candidate_id: T, sent_by: senior.uid, sent_at: new Date().toISOString(), ...(crm ? { client_name: 'Probe Client' } : {}) },
      { candidate_id: T, anonymized_cv_id: anon, score_id: score, sent_by: senior.uid, sent_at: null },
    ]).select('id'), 'CV-sent rows');
    if (crm) must(await admin.from('candidate_placements').insert({ workspace_id: W, candidate_id: T, client_name: 'Probe Client', placed_on: new Date().toISOString().slice(0, 10), placed_by: senior.uid }).select('id').single(), 'placement');
    campaignId = must(await admin.from('campaigns').insert({ workspace_id: W, name: 'Probe Delete Campaign' }).select('id').single(), 'campaign').id as string;
    must(await admin.from('campaign_candidates').insert({ campaign_id: campaignId, candidate_id: T }).select('candidate_id'), 'campaign place');
    must(await admin.from('internal_downloads').insert({ workspace_id: W, candidate_id: T, downloaded_by: senior.uid }).select('id'), 'internal download');

    const sp = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    await signIn(sp, senior);
    const rp = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    await signIn(rp, recruiter);
    const open = async (p: Page, id: string) => { await p.goto(`${BASE}/app/candidates/${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 }); await hydrated(p); };
    const log = async () => ((await admin.from('deletion_log').select('*').eq('workspace_id', W).order('requested_at')).data ?? []) as any[];

    if (STEPS.has('8')) {
      // 1. the recruiter takes c1 off
      await open(rp, T);
      const rDelete = rp.locator(`[data-cert-actions="${c1.id}"] [data-cert-delete]`);
      const why = flat(await rp.locator(`[data-cert-actions="${c1.id}"] [data-cert-delete-why]`).innerText().catch(() => ''));
      check(await rDelete.isDisabled() && /only a senior/i.test(why), "the recruiter's \"Delete permanently\" is disabled and says why", why);
      await rp.locator(`[data-cert-actions="${c1.id}"] [data-cert-remove]`).click();
      const removeText = flat(await rp.locator('[data-cert-remove-box]').innerText().catch(() => ''));
      await rp.locator('[data-cert-remove-confirm]').click();
      await rp.locator(`[data-cert-actions="${c1.id}"]`).waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
      const { data: c1Row } = await admin.from('documents').select('candidate_id, storage_path, attach_reason').eq('id', c1.id).maybeSingle();
      const { count: c1Checks } = await admin.from('verifications').select('id', { count: 'exact', head: true }).eq('document_id', c1.id);
      const moved = !!c1Row?.storage_path && c1Row.storage_path.includes('/unattached/');
      if (moved) files.push({ bucket: 'documents', path: c1Row!.storage_path });
      check(/not deleted/i.test(removeText) && /kept/i.test(removeText) && c1Row?.candidate_id === null && c1Checks === 1 && moved && await exists('documents', c1Row!.storage_path) && !(await exists('documents', c1.path)),
        '"Remove from this candidate" says nothing is deleted, and takes it off — kept, attached to nobody, its issuer check kept, its file moved out of their folder', JSON.stringify({ attached: c1Row?.candidate_id, checks: c1Checks, path: c1Row?.storage_path }));
      check((await rp.locator('[data-candidate-certificate]').count()) === 2, 'their page lists two certificates now, with no reload');

      // 2. the recruiter cannot delete permanently
      const rDel = await rp.request.delete(`${BASE}/api/candidates/${T}/documents/${c2.id}`, { data: { confirm: 'delete' } });
      const { data: c2Still } = await admin.from('documents').select('id').eq('id', c2.id).maybeSingle();
      check(rDel.status() === 403 && !!c2Still, "the recruiter's DELETE is refused (403), and the certificate is still there", `HTTP ${rDel.status()}`);

      // 3. the senior deletes c2 permanently
      await open(sp, T);
      await sp.locator(`[data-cert-actions="${c2.id}"] [data-cert-delete]`).click();
      const deleteText = flat(await sp.locator('[data-cert-delete-box]').innerText().catch(() => ''));
      const confirm = sp.locator('[data-cert-delete-confirm]');
      const disabledAtFirst = await confirm.isDisabled();
      await sp.locator('[data-cert-delete-input]').fill('delet');
      const disabledWhenWrong = await confirm.isDisabled();
      await sp.locator('[data-cert-delete-input]').fill('delete');
      const enabledWhenTyped = !(await confirm.isDisabled());
      const certLabel = await readable(sp, '[data-cert-delete-confirm]');
      check(certLabel.legible, 'the certificate delete button reads clearly — never a blank button', `"${certLabel.text}" ${certLabel.colour} on ${certLabel.behind}`);
      check(/erased and cannot be recovered/i.test(deleteText) && /remove from this candidate instead/i.test(deleteText) && disabledAtFirst && disabledWhenWrong && enabledWhenTyped,
        '"Delete permanently" says it cannot be recovered, points at Remove instead, and stays disabled until "delete" is typed', `${JSON.stringify({ disabledAtFirst, disabledWhenWrong, enabledWhenTyped })} · ${deleteText.slice(0, 120)}`);
      await confirm.click();
      await sp.locator(`[data-cert-actions="${c2.id}"]`).waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
      const { data: c2Gone } = await admin.from('documents').select('id').eq('id', c2.id).maybeSingle();
      const { count: c2Checks } = await admin.from('verifications').select('id', { count: 'exact', head: true }).eq('document_id', c2.id);
      const c2File = await exists('documents', c2.path);
      const c2Shot = await exists('screenshots', `${W}/verify/${c2.id}.png`);
      check(!c2Gone && c2Checks === 0 && !c2File && !c2Shot, 'the senior\'s delete erases the certificate, its issuer check, its file and its screenshot', JSON.stringify({ row: !!c2Gone, checks: c2Checks, file: c2File, screenshot: c2Shot }));
      const docLog = (await log()).find((r) => r.subject_id === c2.id);
      check(!!docLog && docLog.kind === 'document' && docLog.deleted_by === senior.uid && !!docLog.completed_at && !JSON.stringify(docLog).toLowerCase().includes(NAME.toLowerCase()),
        'the deletion log records the document deletion — who and when — with no name in it', docLog ? `${docLog.subject_ref} · removed ${JSON.stringify(docLog.removed)}` : 'no log row');

      // 4. two different boxes, and 390px
      check(removeText !== deleteText && !/cannot be recovered/i.test(removeText), 'the two actions open different boxes with different words — removing never reads as deleting');
      const phone = await browser.newContext({ storageState: await sp.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const m = await phone.newPage();
      await m.addInitScript({ content: shim });
      await open(m, T);
      await m.locator(`[data-cert-actions="${c3.id}"] [data-cert-delete]`).tap();
      const box = await m.locator('[data-cert-delete-box]').boundingBox();
      const certLabelPhone = await readable(m, '[data-cert-delete-confirm]');
      check(certLabelPhone.legible, 'at 390px the certificate delete button reads clearly', `"${certLabelPhone.text}" ${certLabelPhone.colour} on ${certLabelPhone.behind}`);
      check(!!box && box.x >= 0 && box.x + box.width <= 391 && await sideways(m) <= 1, 'at 390px the certificate actions and the delete box fit the screen', `${await sideways(m)}px`);
      await m.getByRole('button', { name: 'Cancel' }).first().tap();
      await phone.close();
    }

    if (STEPS.has('7')) {
      // 5. before
      const ids = await candidateIds(admin, T);
      const before = await candidateRowCounts(admin, T, ids);
      const theirFiles = [...ids.documents.map((d) => ({ bucket: 'documents', path: d.storage_path! })), ...ids.documents.map((d) => ({ bucket: 'screenshots', path: `${W}/verify/${d.id}.png` })), ...ids.anonymizedCvs.map((a) => ({ bucket: 'pdfs', path: a.storage_path! }))];
      const filesBefore = (await Promise.all(theirFiles.map((f) => exists(f.bucket, f.path)))).filter(Boolean).length;
      console.log(`  ...  before: ${JSON.stringify(before)} · ${filesBefore} stored file(s)`);
      check(Object.entries(before).every(([t, n]) => (t === 'candidate_placements' && !crm) || n > 0), 'before: the candidate has rows in every table that references a candidate', JSON.stringify(before));

      // 6. refused
      await open(rp, T);
      const notSenior = flat(await rp.locator('[data-delete-candidate="not-senior"]').innerText().catch(() => ''));
      const rDel = await rp.request.delete(`${BASE}/api/candidates/${T}`, { data: { confirm: NAME } });
      const sWrong = await sp.request.delete(`${BASE}/api/candidates/${T}`, { data: { confirm: 'Somebody Else' } });
      const unchanged = JSON.stringify(await candidateRowCounts(admin, T, ids)) === JSON.stringify(before);
      check(/only a senior can delete a candidate/i.test(notSenior) && rDel.status() === 403 && sWrong.status() === 400 && unchanged,
        "a recruiter sees only a senior can delete, and their DELETE is refused (403); a senior's DELETE with the wrong name is refused (400); nothing changed", `recruiter ${rDel.status()} · wrong name ${sWrong.status()} · unchanged ${unchanged}`);

      // 7. the senior deletes, through the page
      await open(sp, T);
      // What the card shows the senior: the open button, or 'not-senior' / 'not-ready' with its reason.
      const card = await sp.evaluate(() => {
        const open = document.querySelector('[data-delete-candidate-open]');
        const stand = document.querySelector('[data-delete-candidate]');
        return { open: !!open, stood: stand ? stand.getAttribute('data-delete-candidate') : 'no delete card on the page', text: (stand ?? open)?.textContent?.trim().slice(0, 120) ?? '' };
      });
      check(card.open, 'the senior sees the Delete candidate button', card.open ? '' : `the card showed "${card.stood}": ${card.text}`);
      if (!card.open) throw new Error(`the senior cannot open the delete box — the card showed "${card.stood}"`);
      await sp.locator('[data-delete-candidate-open]').click();
      const boxText = flat(await sp.locator('[data-delete-candidate-box]').innerText().catch(() => ''));
      const go = sp.locator('[data-delete-candidate-confirm]');
      const offAtFirst = await go.isDisabled();
      const labelDisabled = await readable(sp, '[data-delete-candidate-confirm]');
      await sp.locator('[data-delete-candidate-input]').fill('Probe Delete');
      const offWhenPartial = await go.isDisabled();
      await sp.locator('[data-delete-candidate-input]').fill('probe delete person');
      const onWhenNamed = !(await go.isDisabled());
      const labelEnabled = await readable(sp, '[data-delete-candidate-confirm]');
      check(labelDisabled.legible && labelEnabled.legible && labelDisabled.text === labelEnabled.text,
        'the delete button reads clearly before and after the name is typed — never a blank button',
        `disabled: "${labelDisabled.text}" ${labelDisabled.colour} on ${labelDisabled.behind} · enabled: "${labelEnabled.text}" ${labelEnabled.colour} on ${labelEnabled.behind}`);
      // Seeded: 2 CVs; 3 certificates, of which step 8 takes one off and deletes one; a CV sent and a pack; a placement; a client version.
      const certsLeft = STEPS.has('8') ? 1 : 3;
      const listsWhatGoes = /2 CVs/.test(boxText) && new RegExp(`${certsLeft} certificates?\\b`).test(boxText) && /2 CV-sent entries/.test(boxText)
        && (!crm || /1 placement\b/.test(boxText)) && /1 client version\b/.test(boxText);
      check(listsWhatGoes && /cannot be recovered/i.test(boxText) && /without their name/i.test(boxText) && offAtFirst && offWhenPartial && onWhenNamed,
        'the box says what goes and that it cannot be recovered, and stays disabled until their name is typed (any case)', `${JSON.stringify({ offAtFirst, offWhenPartial, onWhenNamed })} · ${boxText.slice(0, 200)}`);
      await go.click();
      await sp.waitForURL(/\/app\/candidates\?deleted=/, { timeout: 60000 }).catch(() => {});

      // 8. after
      const after = await candidateRowCounts(admin, T, ids);
      const filesAfter = (await Promise.all(theirFiles.map((f) => exists(f.bucket, f.path)))).filter(Boolean).length;
      console.log(`  ...  after: ${JSON.stringify(after)} · ${filesAfter} stored file(s)`);
      check(sp.url().includes('deleted=') && Object.values(after).every((n) => n === 0), 'after: every table holds 0 rows for them — no orphaned document, verification, client version, CV-sent row, score, placement, campaign place or download', JSON.stringify(after));
      check(filesBefore > 0 && filesAfter === 0, 'after: every one of their stored files is gone — documents, client-version PDFs, issuer screenshots', `${filesBefore} → ${filesAfter}`);
      const { data: k } = await admin.from('candidates').select('id').eq('id', K).maybeSingle();
      const { data: kDoc } = await admin.from('documents').select('id').eq('id', kc.id).maybeSingle();
      const { data: detached } = STEPS.has('8') ? await admin.from('documents').select('id, storage_path').eq('id', c1.id).maybeSingle() : { data: { id: 'n/a', storage_path: null } as any };
      check(!!k && !!kDoc && await exists('documents', kc.path) && !!detached && (detached.storage_path ? await exists('documents', detached.storage_path) : true),
        'the control candidate and their certificate are untouched, and the certificate taken off them earlier is kept', JSON.stringify({ control: !!k, controlCert: !!kDoc, detachedKept: !!detached }));
      await sp.goto(`${BASE}/app/candidates`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const listText = await sp.locator('body').innerText().catch(() => '');
      check(!listText.includes(code('9112')) && listText.includes(code('9113')), 'the candidate list no longer shows them, and still shows the control candidate');
      // Read straight after the delete and again a moment later: a row that fills in between the two was read before the
      // route finished writing it, which is a fault in this check rather than in the deletion.
      let candLog = (await log()).find((r) => r.subject_id === T);
      const firstRead = candLog ? { completed_at: candLog.completed_at, keys: Object.keys(candLog.removed ?? {}) } : null;
      if (!candLog?.completed_at) {
        await sp.waitForTimeout(2000);
        candLog = (await log()).find((r) => r.subject_id === T);
      }
      const secondRead = candLog ? { completed_at: candLog.completed_at, keys: Object.keys(candLog.removed ?? {}) } : null;
      console.log(`  ...  log row straight after the delete: ${JSON.stringify(firstRead)} · two seconds later: ${JSON.stringify(secondRead)}`);
      const logJson = JSON.stringify(candLog ?? {}).toLowerCase();
      check(!!candLog && candLog.kind === 'candidate' && candLog.deleted_by === senior.uid && !!candLog.completed_at && !candLog.error
        && sameCounts(candLog.removed?.before, before) && Object.values(candLog.removed?.after ?? { x: 1 }).every((n) => n === 0)
        && !logJson.includes(NAME.toLowerCase()),
        'the deletion log holds who, when, the before and after counts and the files removed — and not their name',
        candLog ? [
          `${candLog.subject_ref} · files ${JSON.stringify(candLog.removed?.files)}`,
          candLog.kind === 'candidate' ? '' : `kind ${candLog.kind}`,
          candLog.deleted_by === senior.uid ? '' : 'deleted_by is not the senior',
          candLog.completed_at ? '' : 'completed_at is empty',
          candLog.error ? `error ${candLog.error}` : '',
          sameCounts(candLog.removed?.before, before) ? '' : `before differs: log ${JSON.stringify(candLog.removed?.before)} vs probe ${JSON.stringify(before)}`,
          Object.values(candLog.removed?.after ?? { x: 1 }).every((n) => n === 0) ? '' : `after not all zero: ${JSON.stringify(candLog.removed?.after)}`,
          logJson.includes(NAME.toLowerCase()) ? 'THE NAME IS IN THE LOG ROW' : '',
        ].filter(Boolean).join(' · ') : 'no log row');

      // 9. 390px
      const phone = await browser.newContext({ storageState: await sp.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const m = await phone.newPage();
      await m.addInitScript({ content: shim });
      await open(m, K);
      await m.locator('[data-delete-candidate-open]').tap();
      const box = await m.locator('[data-delete-candidate-box]').boundingBox();
      const deleteLabelPhone = await readable(m, '[data-delete-candidate-confirm]');
      check(deleteLabelPhone.legible, 'at 390px the delete button reads clearly before the name is typed', `"${deleteLabelPhone.text}" ${deleteLabelPhone.colour} on ${deleteLabelPhone.behind}`);
      check(!!box && box.x >= 0 && box.x + box.width <= 391 && await sideways(m) <= 1, 'at 390px the delete box fits the screen', `${await sideways(m)}px`);
      await m.locator('[data-delete-candidate-box]').getByRole('button', { name: 'Cancel' }).tap();
      const { data: kStill } = await admin.from('candidates').select('id').eq('id', K).maybeSingle();
      check(!!kStill, 'cancelling deletes nothing');
      await phone.close();
    }
  } catch (e: any) {
    failures++;
    console.log(`\n  FAIL  the probe stopped: ${e?.message ?? e}`);
  } finally {
    await browser.close();
    for (const f of files) await admin.storage.from(f.bucket).remove([f.path]);
    if (campaignId) await admin.from('campaigns').delete().eq('id', campaignId);
    // The senior owns the workspace both accounts worked in, so it and everything in it goes first; the recruiter, who was
    // moved into it, is removed afterwards. Taking the recruiter out first had their auth delete refused twice while the
    // workspace was still being cleared, stranding the account both times (2026-09-16).
    const problems = [await removeProbe(admin, senior.uid, W, null, { clearContent: true }), await removeProbe(admin, recruiter.uid, recruiter.ownWorkspace, null)].filter(Boolean);
    if (problems.length) { failures++; console.log(`\n  FAIL  cleanup — ${problems.join('; ')}`); } else console.log('\nboth probe accounts, the workspace and every seeded row and file removed');
  }
  console.log(failures === 0 ? 'candidate delete probe: all checks passed' : `candidate delete probe: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
