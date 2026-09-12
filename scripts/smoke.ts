/**
 * Post-deploy smoke test: sign in, Home, Today, Leads, a Verify upload and the lead drawer,
 * driven through the real UI against whatever is deployed.
 *
 *   npx tsx --env-file=.env.local scripts/smoke.ts https://leadscout-rfbt.vercel.app
 *
 * Uses a throwaway account with a lead and a CV of its own, and deletes everything afterwards.
 * Exits non-zero if any flow fails, so it can gate a deploy rather than merely describe one.
 */
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';

const BASE = process.argv[2] ?? 'https://leadscout-rfbt.vercel.app';
const EMAIL = `smoke+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = 'probe-password-0123456789';
const CV = fs.existsSync('fixtures/sandblaster-cv.docx') ? 'fixtures/sandblaster-cv.docx' : null;
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const bodyOf = (page: Page) => page.locator('body').innerText().catch(() => '');

(async () => {
  const { data: created, error } = await admin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
    user_metadata: { name: 'Smoke Test', agency: 'Smoke Test Agency' },
  });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me!.workspace_id as string;

  const { data: co } = await admin.from('companies').insert({ workspace_id: workspace, name: 'Smoke Offshore AS', employer_type: 'end_client', country: 'NO' }).select().single();
  const { data: lead } = await admin.from('leads').insert({
    workspace_id: workspace, company_id: co!.id, kind: 'won_work', project_name: 'Smoke frame agreement',
    project_location: 'Norwegian Continental Shelf', country: 'NO', trades_inferred: ['welder'],
    fit_score: 75, status: 'new', source_url: 'https://example.invalid/smoke', source_fetched_at: new Date().toISOString(),
  }).select().single();
  await admin.from('contacts').insert({ lead_id: lead!.id, company_id: co!.id, name: 'Smoke Person', title: 'Head of Operations', email_status: 'unknown' });

  // A posting anchored on the COMPANY and not on a lead — the shape every careers-page and job
  // board posting has. Hiring now was empty for every user for days because RLS still keyed on
  // lead_id, and nothing here noticed: an RLS denial is an empty result, not an error.
  const { error: jpErr } = await admin.from('job_posts').insert({
    company_id: co!.id, source_url: `https://example.invalid/smoke-job-${Date.now()}`,
    title: 'Smoke Welder', role: 'Smoke Welder', trades: ['welder'],
    location: 'Esbjerg, DK', country: 'DK', status: 'open', via: 'http',
    is_trade: true, first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
  });
  if (jpErr) console.log(`  ...  could not seed a job posting: ${jpErr.message}`);

  console.log(`smoke test against ${BASE}\n`);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));

    // 1 — sign in
    // Supabase rate-limits sign-ins per IP, and a day of probe runs trips it. Report what the
    // page actually says and back off, rather than calling the product broken.
    let saidOnPage = '';
    for (let attempt = 1; attempt <= 4 && !/\/app\//.test(page.url()); attempt++) {
      await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.fill('input[type=email]', EMAIL);
      await page.fill('input[type=password]', PASSWORD);
      await page.click('form button:not([type=button])');
      await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});
      if (/\/app\//.test(page.url())) break;
      saidOnPage = await page.evaluate(() => (document.querySelector('.text-bad') as HTMLElement)?.innerText ?? '(no message shown)');
      console.log(`  ...  sign-in attempt ${attempt} did not reach /app — page says: ${saidOnPage}`);
      await page.waitForTimeout(15000 * attempt);
    }
    check(/\/app\//.test(page.url()), 'sign in', page.url().replace(BASE, '') + (saidOnPage ? ` · ${saidOnPage}` : ''));
    // A brand-new account is on onboarding day 1, so it must land on Home. Sign-in used to
    // redirect straight to /app/today, which skipped that decision entirely.
    check(/\/app\/home/.test(page.url()), 'a new user lands on Home', page.url().replace(BASE, ''));

    // 2 — Home
    await page.goto(`${BASE}/app/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    const home = await bodyOf(page);
    check(/Today, in order/.test(home) && /How this list is made/.test(home), 'Home renders');
    check((await page.locator('input[type=search], input[placeholder*="Search" i]').count()) === 0, 'Home has no search bar');

    // 3 — Today
    await page.goto(`${BASE}/app/today`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1200);
    const today = await bodyOf(page);
    check(!/Application error/.test(today) && today.length > 60, 'Today renders');

    // 4 — Leads
    await page.goto(`${BASE}/app/radar`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1200);
    const leads = await bodyOf(page);
    check(/Smoke Offshore AS/.test(leads), 'Leads lists the seeded lead');

    // 4b — Hiring now must show the company-anchored posting. This is the check that was
    // missing when Hiring now sat empty over forty real rows.
    await page.goto(`${BASE}/app/radar?tab=hiring`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    const hiring = await bodyOf(page);
    check(/Smoke Welder/.test(hiring), 'Hiring now lists a company-anchored posting');
    // Any empty state at all is a failure here: one posting was seeded for this workspace, so
    // the table has something to show. The message varies, so match the shapes it can take.
    check(!/No trade postings open|No careers pages found yet|Nothing from an employer/.test(hiring),
      'Hiring now shows the table rather than an empty state');

    // 5 — lead drawer: one tool, end to end
    await page.goto(`${BASE}/app/radar?lead=${lead!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    check(await page.locator('aside').first().isVisible().catch(() => false), 'lead drawer opens');
    const jd = page.locator('aside button.btn-primary:has-text("Write JD")').first();
    if (await jd.count()) {
      await jd.click();
      await page.waitForFunction(() => !document.body.innerText.includes('Writing…'), undefined, { timeout: 75000 }).catch(() => {});
      const drawer = await page.locator('aside').first().innerText();
      check(!drawer.includes('Writing…'), 'drawer never stuck on "Writing…"');
      check(/Job Title|Positions|Responsibilities|Location|took longer|went wrong/i.test(drawer), 'drawer shows a result or a plain error');
    } else check(false, 'drawer Write JD button present');

    // 6 — Verify upload
    if (!CV) { console.log('  SKIP  Verify upload — fixtures/sandblaster-cv.docx not present'); }
    else {
      await page.goto(`${BASE}/app/verify`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500);
      // A deploy swapping mid-run can serve a page without the input for a moment; one
      // reload distinguishes that from the page genuinely being broken.
      const fileInput = page.locator('input[type=file]').first();
      if (!(await fileInput.count())) { await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3000); }
      await page.locator('input[type=file]').first().setInputFiles([CV]).catch(async (e) => { check(false, 'Verify drop zone present', String(e?.message ?? e).slice(0, 80)); throw e; });
      await page.waitForFunction(
        () => /recognised and handled/.test(document.body.innerText) && !/Reading |Checking |Preparing |Writing /.test(document.body.innerText),
        undefined, { timeout: 280000 },
      ).catch(() => {});
      const verify = await bodyOf(page);
      check(/recognised and handled/.test(verify), 'Verify accepts and handles an upload');
      check(!/could not be prepared/.test(verify), 'Verify prepared the client version');
    }

    // 7 — Candidates must list the candidate the upload just created.
    //
    // This is the check that was missing when 0013 added candidates.eu_passport_document_id and
    // candidates.uk_right_to_work_document_id: a third relationship between candidates and
    // documents made every embed between them ambiguous, PostgREST failed the whole query, and
    // the page reported an empty pool it had never actually read. So assert both halves — that
    // a candidate is listed, and that neither the empty state nor the fault banner is showing.
    if (CV) {
      // Wait for the row rather than sleeping at it: the save that Verify does can land a
      // moment after the upload reports done, and a fixed pause turned this into a check that
      // passed or failed on timing — which is worse than no check, because it teaches you to
      // ignore it. Poll with a reload, since the page is server-rendered.
      const listed = /RFBT-[A-Z]-[0-9]{4}/;
      let pool = '';
      for (let i = 0; i < 6; i++) {
        await page.goto(`${BASE}/app/candidates`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(1200);
        pool = await bodyOf(page);
        if (listed.test(pool) || /could not be read/.test(pool)) break;
      }
      check(listed.test(pool), 'Candidates lists the candidate the upload created',
        listed.test(pool) ? '' : pool.replace(/\s+/g, ' ').slice(0, 300));
      check(!/No candidates yet/.test(pool), 'Candidates shows the pool rather than an empty state');
      check(!/could not be read|could not read the pool/.test(pool), 'Candidates read the pool without a query fault');
    }

    check(pageErrors.length === 0, 'no uncaught client errors', pageErrors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    const { data: cands } = await admin.from('candidates').select('id').eq('workspace_id', workspace);
    for (const c of cands ?? []) await admin.from('candidates').delete().eq('id', c.id);
    await admin.from('documents').delete().eq('workspace_id', workspace);
    await admin.from('job_posts').delete().eq('company_id', co!.id);
    await admin.from('outreach').delete().eq('lead_id', lead!.id);
    await admin.from('contacts').delete().eq('lead_id', lead!.id);
    await admin.from('scores').delete().eq('lead_id', lead!.id);
    await admin.from('leads').delete().eq('id', lead!.id);
    await admin.from('companies').delete().eq('id', co!.id);
    await admin.auth.admin.deleteUser(uid);
    await admin.from('workspaces').delete().eq('id', workspace);
    console.log('\ncleaned up the probe user, its workspace and everything it created');
  }
  console.log(failures === 0 ? 'smoke: all flows passed' : `smoke: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
