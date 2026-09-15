/**
 * Item 24 steps 4–7 on screen: a candidate's documents, as a signed-in recruiter at 1500px and at 390px on a touch screen.
 *
 *   npx tsx --env-file=.env.local scripts/candidate-docs-probe.ts https://leadscout-rfbt.vercel.app [--steps 4,5,6,7]
 *
 * Uses the local fixtures verify-e2e drops: fixtures/sandblaster-cv.docx and fixtures/test-certificate.pdf. In a throwaway
 * test workspace it adds a candidate with the Add CV button, opens their page, and then:
 *   4. drags the certificate onto the page's drop zone (1500px, and again at 390px): it attaches to THIS candidate — not
 *      to whoever the name matches — shows the three layers, and a verification is stored, which is what Today's expiry
 *      line reads; a holder name that differs from the candidate's is said.
 *   5. "Read CV" opens the standard reading view (contact, certifications, work history, languages and skills) and
 *      "Download original" returns the file named by number and type, never by a person's name.
 *   6. "View original" shows the uploaded PDF beside the decoded reading.
 *   7. "Generate anonymized version" runs the anonymiser for this candidate and says whether the PII check passed.
 * No page scrolls sideways at 390px. Every model call is metered as test traffic. Everything is removed afterwards.
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe } from '../src/lib/test-data';
import { candidateLabel } from '../src/lib/candidate-number';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const stepsArg = process.argv.indexOf('--steps');
const STEPS = new Set((stepsArg > 0 ? process.argv[stepsArg + 1] : '4,5,6,7').split(',').map((s) => s.trim()));
const CV = 'fixtures/sandblaster-cv.docx';
const CERT = 'fixtures/test-certificate.pdf';
const EMAIL = `candidate-docs-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = `probe-${Date.now()}-0123456789`;
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };
const sideways = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const hydrated = (p: Page) => p.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', undefined, { timeout: 60000 }).catch(() => {});
const shim = 'globalThis.__name = globalThis.__name || function (f) { return f; };';

async function dropOn(p: Page, selector: string, file: string, type: string) {
  const dt = await p.evaluateHandle(({ b64, name, type }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const t = new DataTransfer(); t.items.add(new File([bytes], name, { type })); return t;
  }, { b64: fs.readFileSync(file).toString('base64'), name: file.split('/').pop()!, type });
  await p.dispatchEvent(selector, 'dragover', { dataTransfer: dt });
  await p.dispatchEvent(selector, 'drop', { dataTransfer: dt });
}
const docSettled = (p: Page) => p.waitForFunction(() => document.querySelector('[data-candidate-doc-drop]')?.getAttribute('data-candidate-doc-busy') === 'false' && !!document.querySelector('[data-candidate-doc-result]'), undefined, { timeout: 180000 }).then(() => true).catch(() => false);

(async () => {
  for (const f of [CV, CERT]) if (!fs.existsSync(f)) { console.error(`${f} is not on this machine`); process.exit(1); }
  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Candidate Docs Probe', agency: 'Candidate Docs Probe' } });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);
  await admin.from('users').update({ role: 'recruiter', onboarding_day: 30 }).eq('id', uid);
  await followAllForProbe(admin, uid);
  const startedAt = new Date().toISOString();

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    await page.addInitScript({ content: shim });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});

    // A candidate, added the way a recruiter adds one.
    await page.goto(`${BASE}/app/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);
    await page.locator('[data-candidate-drop-input]').setInputFiles(CV);
    await page.waitForSelector('[data-drop-result="created"]', { timeout: 180000 }).catch(() => {});
    const { data: cands } = await admin.from('candidates').select('id, reference_code, full_name').eq('workspace_id', workspace);
    const cand = cands?.[0];
    check((cands ?? []).length === 1, 'a candidate was added with the Add CV button', JSON.stringify(cands));
    if (!cand) throw new Error('no candidate to test with');
    const pageUrl = `${BASE}/app/candidates/${cand.id}`;
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);

    if (STEPS.has('4')) {
      await dropOn(page, '[data-candidate-doc-drop]', CERT, 'application/pdf');
      check(await docSettled(page), 'at 1500px the certificate dropped on the page is read and checked with its issuer');
      await page.waitForFunction(() => !/Reading the code…/i.test(document.body.innerText), undefined, { timeout: 30000 }).catch(() => {});
      const result = (await page.locator('[data-candidate-doc-result="certificate"]').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      const { data: certs } = await admin.from('documents').select('id, candidate_id, extracted, verifications(id, state, valid_until)').eq('workspace_id', workspace).eq('type', 'certificate');
      const cert = certs?.[0];
      check((certs ?? []).length === 1 && cert?.candidate_id === cand.id, 'it attached to this candidate, whatever name is printed on it', JSON.stringify(certs?.map((c: any) => c.candidate_id === cand.id)));
      check(/what the document says/i.test(result) && /what this certificate means|unrecognised/i.test(result) && /confirmation/i.test(result), 'the dropped certificate shows its layers', result.slice(0, 200));
      check((cert?.verifications ?? []).length === 1 && !!(cert!.verifications as any[])[0].state, 'a verification is stored — the row Today reads for expiry', JSON.stringify(cert?.verifications));
      const holder = (cert?.extracted as any)?.holder;
      const differs = holder && holder.toLowerCase().replace(/\W+/g, '') !== String(cand.full_name ?? '').toLowerCase().replace(/\W+/g, '');
      const note = await page.locator('[data-holder-note]').count();
      check(differs ? note >= 1 : note === 0, differs ? 'the holder name differs from the candidate\'s, and the page says so' : 'the holder name is the candidate\'s, and no warning is shown', `holder "${holder}" · candidate "${cand.full_name}"`);
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      check((await page.locator('[data-candidate-certificate]').count()) === 1, 'after the refresh the certificate is on the candidate\'s page');
    }

    if (STEPS.has('5')) {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(page);
      await page.locator('[data-read-cv]').click();
      await page.waitForURL(/\/cv$/, { timeout: 60000 }).catch(() => {});
      const sections = await page.locator('[data-cv-section]').evaluateAll((els) => els.map((e) => e.getAttribute('data-cv-section')));
      check(['contact', 'certifications', 'work-history', 'skills'].every((s) => sections.includes(s)), 'Read CV opens the standard reading view: contact, certifications, work history, languages and skills', sections.join(', '));
      const href = await page.locator('[data-cv-download]').getAttribute('href');
      const res = await page.request.get(`${BASE}${href}`, { maxRedirects: 5 });
      const disposition = res.headers()['content-disposition'] ?? '';
      const nameParts = String(cand.full_name ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      check(res.status() === 200 && (await res.body()).length > 1000, 'Download original returns the uploaded file', `HTTP ${res.status()} · ${(await res.body()).length} bytes`);
      check(new RegExp(`candidate-${candidateLabel(cand.reference_code).slice(1)}-cv\\.docx`).test(disposition) && !nameParts.some((w) => disposition.toLowerCase().includes(w)), 'the download is named by number and type, never by the person', disposition);

      // SENSITIVE PERSONAL DATA: the file route hands out a storage link only to someone whose own session can read the
      // document. Signed out gets nothing; a document in another workspace is "no such document" to this session.
      const pageLink = await (async () => { await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); return page.locator('[data-download-cv]').getAttribute('href').catch(() => null); })();
      check(!!pageLink && /^\/api\/candidates\/document\?id=[0-9a-f-]{36}&download=1$/.test(pageLink), "the candidate page's Download original goes through the same checked route", String(pageLink));
      const signedOut = await browser.newContext();
      try {
        const r = await signedOut.request.get(`${BASE}${href}`, { maxRedirects: 0 });
        const where = r.headers()['location'] ?? '';
        check([401, 403, 404].includes(r.status()) || (r.status() >= 300 && r.status() < 400 && /\/login/.test(where)), 'signed out, the file route gives no file and no storage link', `HTTP ${r.status()}${where ? ` → ${where.slice(0, 60)}` : ''}`);
        check(!/supabase|storage|token=/i.test(where) && !/supabase|token=/i.test((await r.text()).slice(0, 2000)), 'signed out, no storage link appears in the answer');
      } finally { await signedOut.close(); }
      let otherUid: string | null = null; let otherWs: string | null = null;
      try {
        const { data: other, error: otherErr } = await admin.auth.admin.createUser({ email: `candidate-docs-other+${Date.now()}@rfbt-recruitment.com`, password: `probe-${Date.now()}-other-0123456789`, email_confirm: true, user_metadata: { name: 'Docs Probe Other', agency: 'Docs Probe Other' } });
        if (otherErr) throw new Error(otherErr.message);
        otherUid = other.user!.id;
        otherWs = ((await admin.from('users').select('workspace_id').eq('id', otherUid).maybeSingle()).data?.workspace_id as string) ?? null;
        await markWorkspaceTest(admin, otherWs!);
        const { data: foreign, error: fErr } = await admin.from('documents').insert({ workspace_id: otherWs, type: 'cv', storage_path: `docs-probe/other-${Date.now()}.docx`, extracted: { doc_type: 'cv' }, is_test: true }).select('id').single();
        if (fErr) throw new Error(fErr.message);
        const r = await page.request.get(`${BASE}/api/candidates/document?id=${foreign!.id}&download=1`, { maxRedirects: 0 });
        check(r.status() === 404 && !r.headers()['location'], "a document in another workspace is refused to this recruiter, with no storage link", `HTTP ${r.status()}`);
      } catch (e: any) {
        check(false, 'the other-workspace document check ran', e?.message ?? String(e));
      } finally {
        if (otherUid || otherWs) { const left = await removeProbe(admin, otherUid, otherWs, null, { clearContent: true }); if (left) check(false, 'the other workspace was removed', left); }
      }
    }

    if (STEPS.has('6')) {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(page);
      const view = page.locator('[data-view-original]').first();
      if (!(await view.count())) check(false, 'View original is on the certificate (step 4 must run first)');
      else {
        await view.click();
        await page.waitForURL(/\/documents\//, { timeout: 60000 }).catch(() => {});
        await page.waitForFunction(() => !/Reading the code…/i.test(document.body.innerText), undefined, { timeout: 30000 }).catch(() => {});
        const kind = await page.locator('[data-original-kind]').getAttribute('data-original-kind').catch(() => null);
        const decoded = (await page.locator('[data-decoded]').innerText().catch(() => '')).replace(/\s+/g, ' ');
        const src = await page.locator('[data-original] iframe, [data-original] img').first().getAttribute('src').catch(() => null);
        const file = src ? await page.request.get(`${BASE}${src}`, { maxRedirects: 5 }) : null;
        check(kind === 'pdf' && file?.status() === 200 && /pdf/.test(file.headers()['content-type'] ?? ''), 'View original shows the uploaded PDF', `${kind} · HTTP ${file?.status()} · ${file?.headers()['content-type']}`);
        check(/what the document says/i.test(decoded) && /confirmation/i.test(decoded), 'the decoded reading is beside it', decoded.slice(0, 160));
        const boxes = await page.evaluate(() => { const a = document.querySelector('[data-original]')!.getBoundingClientRect(); const b = document.querySelector('[data-decoded]')!.getBoundingClientRect(); return { sideBySide: Math.abs(a.top - b.top) < 5 && b.left > a.left }; });
        check(boxes.sideBySide, 'at 1500px the original and the decoded reading are side by side');
      }
    }

    if (STEPS.has('7')) {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(page);
      await page.locator('[data-anonymize-run]').click();
      const done = await page.waitForSelector('[data-anonymize-result], [data-anonymize-error]', { timeout: 180000 }).then(() => true).catch(() => false);
      const state = await page.locator('[data-anonymize-result]').getAttribute('data-anonymize-result').catch(() => null);
      const { data: anon } = await admin.from('anonymized_cvs').select('pii_check_passed, storage_path').eq('candidate_id', cand.id);
      check(done && !!state && (anon ?? []).length >= 1 && (anon![0].pii_check_passed === (state === 'passed')), 'Generate anonymized version runs for this candidate and says whether the PII check passed', `${state} · ${JSON.stringify(anon)}`);
    }

    // ---- 390px
    const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const m = await phone.newPage();
    await m.addInitScript({ content: shim });
    await m.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(m);
    check(await sideways(m) <= 1, 'at 390px the candidate page does not scroll sideways', `${await sideways(m)}px`);
    if (STEPS.has('4')) {
      await dropOn(m, '[data-candidate-doc-drop]', CERT, 'application/pdf');
      check(await docSettled(m), 'at 390px a certificate dropped on the page is read and checked');
      const { data: again } = await admin.from('documents').select('candidate_id').eq('workspace_id', workspace).eq('type', 'certificate');
      check((again ?? []).length === 2 && again!.every((d: any) => d.candidate_id === cand.id), 'at 390px it attached to this candidate too', `${(again ?? []).length} certificates`);
      check(await sideways(m) <= 1, 'at 390px the drop result does not scroll the page sideways', `${await sideways(m)}px`);
    }
    if (STEPS.has('5')) {
      await m.goto(`${pageUrl}/cv`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      check(await sideways(m) <= 1, 'at 390px the CV reading view does not scroll sideways (work history scrolls in its own frame)', `${await sideways(m)}px`);
    }
    if (STEPS.has('6')) {
      const { data: one } = await admin.from('documents').select('id').eq('workspace_id', workspace).eq('type', 'certificate').limit(1);
      if (one?.[0]) {
        await m.goto(`${pageUrl}/documents/${one[0].id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        check(await sideways(m) <= 1, 'at 390px the original and its reading stack without scrolling sideways', `${await sideways(m)}px`);
      }
    }
    await phone.close();

    const { data: cost } = await admin.from('cost_log').select('kind, eur, detail').eq('workspace_id', workspace).gte('created_at', startedAt);
    check((cost ?? []).length > 0 && (cost ?? []).every((c: any) => String(c.detail).startsWith('test workspace')), 'every model call was metered as test traffic', `${(cost ?? []).length} attempt(s) · ${[...new Set((cost ?? []).map((c: any) => c.kind))].join(', ')} · €${(cost ?? []).reduce((a: number, c: any) => a + Number(c.eur), 0).toFixed(4)}`);
  } finally {
    await browser.close();
    const leftBehind = await removeProbe(admin, uid, workspace, null, { clearContent: true });
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); } else console.log('\nprobe user, its workspace, candidate and documents removed');
  }
  console.log(failures === 0 ? 'candidate docs probe: all checks passed' : `candidate docs probe: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
