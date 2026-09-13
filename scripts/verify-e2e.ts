/**
 * Drive Verify exactly as a recruiter does, and check that it did the work. Part of the release gate.
 *
 *   npx tsx --env-file=.env.local scripts/verify-e2e.ts http://localhost:3100
 *
 * Signs in as a throwaway account, drops a CV, a certificate and a contract into the one drop zone,
 * then checks what happened instead of only printing it. Until 2026-09-13 this script failed only when
 * sign-in failed: it printed the result cards and exited 0 whatever they said, so its "pass" in the
 * gate meant it ran, not that Verify worked. Each check now reads the API's own answer and the rows it
 * wrote, never wording a model chose:
 *
 *   intake    answers 200 and accounts for all three files
 *   CV        recognised, and a candidate exists in this workspace with the reference code it reported
 *   cert      recognised and stored, put to its issuer (/api/verify/lookup answered) and the answer
 *             recorded as a verifications row — whatever the answer was, "not supported" included
 *   contract  recognised and stored
 *   client    the anonymised CV prepared: enrich answered 200, the PII check passed, the client PDF stored
 *   screen    settles within 280 s, says "recognised and handled", and shows no failed CV or client version
 *
 * The account and its workspace are marked is_test and removed afterwards with everything they made; a
 * leftover fails the run. Exits 1 if any check fails.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { markWorkspaceTest, removeProbe } from '../src/lib/test-data';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const EMAIL = `verify-e2e+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = 'probe-password-0123456789';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

type Answer = { status: number; body: any };

(async () => {
  const { data: created, error } = await admin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
    user_metadata: { name: 'Verify E2E', agency: 'Verify E2E Agency' },
  });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  // Marked before anything is created, so the cleanup's is_test filter can only reach this probe's rows.
  await markWorkspaceTest(admin, workspace);
  console.log(`probe user ${EMAIL}\nworkspace ${workspace}\n`);

  // What the app answered, kept for the checks — not only printed.
  const api: { intake: Answer | null; lookups: Answer[]; enrich: Answer[] } = { intake: null, lookups: [], enrich: [] };
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('response', async (r) => {
      const u = r.url();
      if (!/\/api\/(verify|anonymize)/.test(u)) return;
      let text = '';
      try { text = await r.text(); } catch { text = ''; }
      let body: any = null;
      try { body = JSON.parse(text); } catch { /* an error page, not JSON */ }
      console.log(`   NET ${r.status()} ${r.request().method()} ${u.replace(BASE, '')}\n       ${(text || '(unreadable)').slice(0, 240).replace(/\s+/g, ' ')}`);
      const answer = { status: r.status(), body };
      if (/\/api\/verify\/intake/.test(u)) api.intake = answer;
      else if (/\/api\/verify\/lookup/.test(u)) api.lookups.push(answer);
      else if (/\/api\/anonymize\/enrich/.test(u)) api.enrich.push(answer);
    });
    page.on('console', (m) => { if (m.type() === 'error') console.log('   BROWSER ERROR: ' + m.text().slice(0, 160)); });

    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});

    // Supabase rate-limits sign-ins per IP; repeated probe runs trip it. Report what the page
    // actually said, wait, and try again rather than failing on a locator timeout later.
    for (let attempt = 1; attempt <= 3 && !/\/app\//.test(page.url()); attempt++) {
      const shown = await page.evaluate(() => (document.querySelector('.text-bad') as HTMLElement)?.innerText ?? '(no message shown)');
      console.log(`sign-in attempt ${attempt} did not reach /app — page says: ${shown}`);
      await page.waitForTimeout(15000 * attempt);
      await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.fill('input[type=email]', EMAIL);
      await page.fill('input[type=password]', PASSWORD);
      await page.click('form button:not([type=button])');
      await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});
    }
    if (!/\/app\//.test(page.url())) throw new Error('could not sign in after 3 attempts');
    console.log('signed in ->', page.url(), '\n');

    console.log('=== ONE DROP ZONE: CV + certificate + contract ===');
    await page.goto(`${BASE}/app/verify`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.locator('input[type=file]').first().setInputFiles([
      'fixtures/sandblaster-cv.docx',
      'fixtures/test-certificate.pdf',
      'design/samples/BWO_contract_sample.pdf',
    ]);
    const started = Date.now();
    const settled = await page.waitForFunction(
      () => /recognised and handled/.test(document.body.innerText) && !!document.querySelector('[data-verify-busy="false"]'),
      undefined, { timeout: 280000 },
    ).then(() => true).catch(() => false);
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`   ${settled ? 'settled' : 'still working'} after ${seconds}s`);
    await page.screenshot({ path: 'fixtures/verify-all.png', fullPage: true });
    const cards = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll('.bg-panel.border').forEach((el) => {
        const t = (el as HTMLElement).innerText.trim();
        if (t.length > 60) out.push(t);
      });
      return out;
    });
    cards.forEach((c) => {
      console.log('\n--- card ---');
      console.log(c.split('\n').map((l) => '   | ' + l).join('\n'));
    });
    console.log('');

    // ---------------------------------------------------------------- the screen
    const screen = await page.locator('body').innerText();
    check(settled, "Verify settles within 280 s — the page's own progress marker says nothing is still running", `${seconds}s`);
    check(/recognised and handled/.test(screen) && !/could not be read into a candidate|could not be prepared/.test(screen),
      'the screen says the files were recognised and handled, with no failed CV and no failed client version');

    // ---------------------------------------------------------------- the API's answer and the rows behind it
    const intake = api.intake;
    check(intake?.status === 200 && intake.body?.files === 3, 'intake answers 200 and accounts for all three files',
      JSON.stringify({ status: intake?.status ?? 'no intake response', files: intake?.body?.files, error: intake?.body?.error }));
    const files: any[] = [
      ...(intake?.body?.candidates ?? []).flatMap((c: any) => (c.files ?? []).map((f: any) => ({ ...f, reference: c.reference_code }))),
      ...(intake?.body?.loose ?? []),
    ];
    const kinds = files.map((f) => f.kind);
    const cv = files.find((f) => f.kind === 'cv');
    const cert = files.find((f) => f.kind === 'certificate');
    const contract = files.find((f) => f.kind === 'contract');

    const { data: candidate } = cv?.candidateId
      ? await admin.from('candidates').select('id, reference_code, workspace_id, created_via').eq('id', cv.candidateId).maybeSingle()
      : { data: null as any };
    check(!!cv && !!candidate && candidate.workspace_id === workspace && candidate.reference_code === cv.reference,
      'the CV is recognised and creates a candidate in this workspace, with the reference code shown',
      JSON.stringify({ kinds, candidate: candidate && { reference: candidate.reference_code, via: candidate.created_via } }));

    const documentIn = async (id?: string) => {
      if (!id) return null;
      const { data } = await admin.from('documents').select('id, type, workspace_id, uploaded_by').eq('id', id).maybeSingle();
      return data;
    };
    const certDoc = await documentIn(cert?.documentId);
    check(!!certDoc && certDoc.workspace_id === workspace && certDoc.uploaded_by === uid, 'the certificate is recognised and stored in this workspace',
      JSON.stringify({ kinds, document: certDoc && { type: certDoc.type } }));
    const { data: certChecks } = cert?.documentId
      ? await admin.from('verifications').select('method, result, state').eq('document_id', cert.documentId)
      : { data: [] as any[] };
    check(api.lookups.some((l) => l.status === 200) && (certChecks?.length ?? 0) > 0,
      "the certificate is put to its issuer and the answer recorded, whatever the answer",
      JSON.stringify({ lookups: api.lookups.map((l) => l.status), recorded: certChecks }));

    const contractDoc = await documentIn(contract?.documentId);
    check(!!contractDoc && contractDoc.workspace_id === workspace && contractDoc.uploaded_by === uid, 'the contract is recognised and stored in this workspace',
      JSON.stringify({ kinds, document: contractDoc && { type: contractDoc.type } }));

    const enriched = api.enrich.find((e) => e.status === 200);
    const { data: clientCvs } = candidate
      ? await admin.from('anonymized_cvs').select('pii_check_passed, storage_path').eq('candidate_id', candidate.id)
      : { data: [] as any[] };
    check(enriched?.body?.piiPassed === true && (clientCvs ?? []).some((a: any) => a.pii_check_passed && a.storage_path),
      'the client version is prepared: the PII check passed and the client PDF is stored',
      JSON.stringify({ enrich: api.enrich.map((e) => ({ status: e.status, piiPassed: e.body?.piiPassed, error: e.body?.error })), stored: clientCvs }));
  } catch (e: any) {
    failures++;
    console.log(`\n  FAIL  the run stopped before its checks finished: ${String(e?.message ?? e).split('\n')[0]}`);
  } finally {
    await browser.close();
    // Content in foreign-key order, then the user, then the workspace, twice if needed: this script's
    // gate run at 20:06 UTC on 2026-09-13 left all of them behind when its deletes were fired unread.
    const leftBehind = await removeProbe(admin, uid, workspace, null, { clearContent: true });
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); }
    else console.log('\ncleaned up probe user, workspace and everything it created');
  }
  console.log(failures === 0 ? 'verify e2e: all checks passed' : `verify e2e: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
