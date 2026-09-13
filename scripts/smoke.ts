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
import { execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { markWorkspaceTest, markTest } from '../src/lib/test-data';

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
  // Mark everything this run creates before creating it, so a cleanup can never reach a real
  // record even if the scoping below is wrong.
  await markWorkspaceTest(admin, workspace);

  const { data: co } = await admin.from('companies').insert({ workspace_id: workspace, name: 'Smoke Offshore AS', employer_type: 'end_client', country: 'NO' }).select().single();
  await markTest(admin, 'companies', [co!.id]);
  const { data: lead } = await admin.from('leads').insert({
    workspace_id: workspace, company_id: co!.id, kind: 'won_work', project_name: 'Smoke frame agreement',
    project_location: 'Norwegian Continental Shelf', country: 'NO', trades_inferred: ['welder'],
    fit_score: 75, status: 'new', source_url: 'https://example.invalid/smoke', source_fetched_at: new Date().toISOString(),
  }).select().single();
  await admin.from('contacts').insert({ lead_id: lead!.id, company_id: co!.id, name: 'Smoke Person', title: 'Head of Operations', email_status: 'unknown' });

  // A lead from a contract award notice beside the news lead, so the Leads table has one of each
  // source to tag. The path starts "smoke-": no real TED notice id starts with a word.
  const { data: tenderCo } = await admin.from('companies').insert({ workspace_id: workspace, name: 'Smoke Tender Winner AS', employer_type: 'unknown', country: 'DK' }).select().single();
  await markTest(admin, 'companies', [tenderCo!.id]);
  const { data: tenderLead } = await admin.from('leads').insert({
    workspace_id: workspace, company_id: tenderCo!.id, kind: 'won_work', project_name: 'Smoke quay award',
    project_location: 'DNK', country: 'DK', trades_inferred: ['welder'], fit_score: 70, status: 'new',
    source_url: `https://ted.europa.eu/en/notice/-/detail/smoke-${Date.now()}`, source_fetched_at: new Date().toISOString(),
  }).select().single();
  await markTest(admin, 'leads', [lead!.id, tenderLead!.id]);

  // A person read off a company's organisation page hangs from the company, not a lead. 0001's
  // contacts policy hid every such row from signed-in users, so Karstensens' drawer showed a
  // switchboard and no name while René Hansen sat in the table. Seed one and look for it on screen.
  const { data: orgCo } = await admin.from('companies').insert({ workspace_id: workspace, name: 'Smoke Org Page AS', employer_type: 'end_client', country: 'NO' }).select().single();
  await markTest(admin, 'companies', [orgCo!.id]);
  await admin.from('job_posts').insert({
    company_id: orgCo!.id, source_url: `https://example.invalid/smoke-org-job-${Date.now()}`,
    title: 'Smoke Fitter', role: 'Smoke Fitter', trades: ['fitter'], location: 'Bergen, NO', country: 'NO', status: 'open', via: 'http',
    is_trade: true, first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), is_test: true,
  });
  const { data: orgContact, error: orgErr } = await admin.from('contacts').insert({
    company_id: orgCo!.id, lead_id: null, name: 'Smoke Orgpage Person', title: 'Production Manager',
    source_url: 'https://example.invalid/smoke-organization', email_status: 'unknown', is_test: true,
  }).select('id').single();
  if (orgErr) console.log(`  ...  could not seed an organisation-page contact: ${orgErr.message}`);

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

  // Against a deployed base, wait until the build serving requests is the commit we mean to
  // test. A run that starts seconds after a push tests the previous build and reports failures
  // against correct code — which sends you hunting a bug that is not there.
  if (!/localhost|127\.0\.0\.1/.test(BASE)) {
    const want = execSync('git rev-parse HEAD').toString().trim();
    const deadline = Date.now() + 240_000;
    let serving = '';
    while (Date.now() < deadline) {
      serving = await fetch(`${BASE}/api/health`, { cache: 'no-store' })
        .then((r) => r.json()).then((j: any) => j?.sha ?? '').catch(() => '');
      if (serving === want) break;
      if (!serving) { console.log('  ...  /api/health has no commit to report — not waiting'); break; }
      console.log(`  ...  waiting for the deploy: serving ${serving.slice(0, 7)}, want ${want.slice(0, 7)}`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
    if (serving && serving !== want) {
      console.log(`\n  STOP  ${BASE} is still serving ${serving.slice(0, 7)}, not ${want.slice(0, 7)}. Nothing was tested.`);
      await admin.auth.admin.deleteUser(uid);
      process.exit(2);
    }
  }

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
    // Each row carries its source as an attribute and a visible word. Read both off the row that
    // names the company, so the check cannot pass on a tag belonging to some other lead.
    const tags = await page.evaluate(() => Array.from(document.querySelectorAll('tr[data-lead-source]')).map((tr) => ({
      text: (tr as HTMLElement).innerText,
      source: tr.getAttribute('data-lead-source'),
      tag: (tr.querySelector('[data-source]') as HTMLElement | null)?.innerText ?? '',
    })));
    const tenderRow = tags.find((t) => t.text.includes('Smoke Tender Winner AS'));
    const newsRow = tags.find((t) => t.text.includes('Smoke Offshore AS'));
    check(tenderRow?.source === 'tender' && /Tender award/.test(tenderRow.tag), 'a TED-sourced lead is tagged "Tender award"', JSON.stringify(tenderRow ? { source: tenderRow.source, tag: tenderRow.tag } : 'row not found'));
    check(newsRow?.source === 'news' && /News/.test(newsRow.tag), 'a news-sourced lead is tagged "News"', JSON.stringify(newsRow ? { source: newsRow.source, tag: newsRow.tag } : 'row not found'));
    // The chip for the view you are on must look selected. `.chip` sits after the utilities in
    // globals.css, so a plain bg-rail lost to it and "All" rendered white with its count in white.
    const allChip = await page.evaluate(() => {
      const a = document.querySelector('[data-source-filter] a') as HTMLElement | null;
      return a ? { bg: getComputedStyle(a).backgroundColor, text: a.innerText } : null;
    });
    check(allChip?.bg === 'rgb(14, 26, 43)' && /All\s*\d+/.test(allChip.text), 'the "All" chip shows as selected, with its count', JSON.stringify(allChip));
    // A row must say it opens something: a chevron drawn on the row (not only on hover), a hover
    // tint, and a click on a plain cell — not the company link — opens the drawer. The Trades cell
    // (the fourth) holds no link on either table.
    const rowOpens = async (rowText: string, param: RegExp, what: string) => {
      const row = page.locator('tr[data-row-href]', { hasText: rowText }).first();
      const cell = row.locator('td').nth(3);
      const chevron = await row.locator('[data-row-open]').isVisible().catch(() => false);
      const before = await cell.evaluate((td) => getComputedStyle(td).backgroundColor).catch(() => '');
      await cell.hover({ position: { x: 4, y: 4 } }).catch(() => {});
      const after = await cell.evaluate((td) => getComputedStyle(td).backgroundColor).catch(() => '');
      await cell.click({ position: { x: 4, y: 4 } }).catch(() => {});
      await page.waitForURL(param, { timeout: 30000 }).catch(() => {});
      const drawer = await page.locator('aside').first().isVisible().catch(() => false);
      // The designed tint (#F2F6FC), not merely "changed": the old near-white hover also changed.
      check(chevron && after === 'rgb(242, 246, 252)' && before !== after && param.test(page.url()) && drawer, `${what}: chevron on the row, hover tint, a click on a plain cell opens the drawer`, JSON.stringify({ chevron, before, after, url: page.url().replace(BASE, ''), drawer }));
    };
    await rowOpens('Smoke Offshore AS', /[?&]lead=/, 'Leads row');
    await page.goto(`${BASE}/app/radar`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // The source filter narrows the table to one kind, and the other kind is gone from it.
    await page.goto(`${BASE}/app/radar?tab=won&source=tender`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('tr[data-lead-source]', { timeout: 60000 }).catch(() => {});
    const onlyTender = await page.evaluate(() => Array.from(document.querySelectorAll('tr[data-lead-source]')).map((tr) => ({ source: tr.getAttribute('data-lead-source'), text: (tr as HTMLElement).innerText })));
    check(onlyTender.some((r) => r.text.includes('Smoke Tender Winner AS')) && onlyTender.every((r) => r.source === 'tender'), '?source=tender shows only award-notice leads', `${onlyTender.length} rows, kinds: ${[...new Set(onlyTender.map((r) => r.source))].join(',')}`);

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
    await rowOpens('Smoke Offshore AS', /[?&]company=/, 'Hiring now row');

    // The same at 390px on a touch screen. There is no hover there, so the chevron must already be
    // on screen inside the first column, and a tap on the row must open the drawer.
    const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const m = await phone.newPage();
      for (const [path, param, what] of [['/app/radar', /[?&]lead=/, 'Leads row'], ['/app/radar?tab=hiring', /[?&]company=/, 'Hiring now row']] as const) {
        await m.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await m.waitForSelector('tr[data-row-href]', { timeout: 60000 }).catch(() => {});
        const row = m.locator('tr[data-row-href]', { hasText: 'Smoke Offshore AS' }).first();
        const box = await row.locator('[data-row-open]').boundingBox().catch(() => null);
        const onScreen = !!box && box.width > 0 && box.x >= 0 && box.x + box.width <= 390;
        await row.locator('td').nth(3).tap({ position: { x: 4, y: 4 } }).catch(() => {});
        await m.waitForURL(param, { timeout: 30000 }).catch(() => {});
        const drawer = await m.locator('aside').first().isVisible().catch(() => false);
        check(onScreen && param.test(m.url()) && drawer, `${what} at 390px, touch: chevron on screen without hover, a tap opens the drawer`, JSON.stringify({ chevron: box && { x: Math.round(box.x), w: Math.round(box.width) }, url: m.url().replace(BASE, ''), drawer }));
      }
    } finally {
      await phone.close();
    }

    // 4c — the Hiring now drawer. A row a recruiter cannot open is a table, not a screen.
    await page.goto(`${BASE}/app/radar?tab=hiring&company=${co!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Wait for the contact sheet to settle rather than sleeping at it. The sheet is fetched
    // after the drawer paints, so a fixed pause makes these checks turn on timing — and a
    // check that passes or fails on timing is worse than no check, because it teaches you to
    // ignore a red.
    await page.waitForFunction(
      () => { const a = document.querySelector('aside'); return !!a && !a.innerText.includes('Reading what we hold'); },
      undefined, { timeout: 60000 },
    ).catch(() => {});
    const hd = await page.locator('aside').first().innerText().catch(() => '');
    check(/Smoke Offshore AS/.test(hd), 'Hiring now drawer opens on the company');
    check(/Who to contact/.test(hd), 'drawer shows the contact block');
    check(/What they are hiring for/.test(hd) && /Smoke Welder/.test(hd), 'drawer lists the postings');
    // Nobody was seeded with a contact, so the honest answer is searches — never a made-up name.
    check(/searches to run/.test(hd), 'drawer offers searches when nobody was found');

    // 4d — a contact on the company alone, as the organisation-page pass stores them.
    await page.goto(`${BASE}/app/radar?tab=hiring&company=${orgCo!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => { const a = document.querySelector('aside'); return !!a && !a.innerText.includes('Reading what we hold'); },
      undefined, { timeout: 60000 },
    ).catch(() => {});
    const orgDrawer = await page.locator('aside').first().innerText().catch(() => '');
    check(/Smoke Orgpage Person/.test(orgDrawer) && /Production Manager/.test(orgDrawer), 'an organisation-page contact on the company is shown to a signed-in user', /Smoke Orgpage Person/.test(orgDrawer) ? '' : orgDrawer.replace(/\s+/g, ' ').slice(0, 200));

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
      // Structural, not textual. This used to match on "Job Title|Positions|Responsibilities",
      // which asserts the wording of model output: a perfectly good job description that opened
      // differently failed the check and sent you looking for a bug in the drawer. What matters
      // is that the drawer answered — a result block with something in it, or a stated failure.
      const answered = await page.evaluate(() => {
        const a = document.querySelector('aside');
        if (!a) return { body: 0, error: false };
        // The result carries data-result, so this asks "did the drawer answer" without
        // depending on which element it answered in or what the model chose to write.
        const res = Array.from(a.querySelectorAll('[data-result]')).map((p) => p.textContent ?? '').join('');
        const error = !!a.querySelector('.text-bad');
        return { body: res.trim().length, error };
      });
      check(answered.body > 60 || answered.error, 'drawer shows a result or a plain error',
        answered.body > 60 || answered.error ? '' : `no result block and no error in the drawer (${answered.body} chars)`);
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
    // Whether the upload actually produced a candidate is a question for the database, not for
    // the page: if intake failed, "No candidates yet" is the correct thing for Candidates to
    // show, and asserting a row is there turns an upstream flake into a false failure on a
    // screen that is behaving. The service-role query decides whether the assertion applies;
    // the screen is still what answers it.
    const { data: made } = await admin.from('candidates').select('reference_code').eq('workspace_id', workspace);
    const expected = (made ?? []).length;
    if (CV && expected === 0) {
      console.log('  ...  the Verify upload produced no candidate this run — the listing check does not apply');
    }
    if (CV && expected > 0) {
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
      check(!/No candidates yet/.test(pool), `Candidates shows the pool rather than an empty state (${expected} in the database)`);
      check(!/could not be read|could not read the pool/.test(pool), 'Candidates read the pool without a query fault');
    }

    check(pageErrors.length === 0, 'no uncaught client errors', pageErrors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    const { data: cands } = await admin.from('candidates').select('id').eq('workspace_id', workspace);
    for (const c of cands ?? []) await admin.from('candidates').delete().eq('id', c.id);
    await admin.from('documents').delete().eq('workspace_id', workspace);
    await admin.from('job_posts').delete().eq('company_id', co!.id);
    if (orgContact) await admin.from('contacts').delete().eq('id', orgContact.id).eq('is_test', true);
    if (orgCo) { await admin.from('job_posts').delete().eq('company_id', orgCo.id).eq('is_test', true); await admin.from('companies').delete().eq('id', orgCo.id).eq('is_test', true); }
    await admin.from('outreach').delete().eq('lead_id', lead!.id);
    await admin.from('contacts').delete().eq('lead_id', lead!.id);
    await admin.from('scores').delete().eq('lead_id', lead!.id);
    await admin.from('leads').delete().eq('id', lead!.id);
    if (tenderLead) await admin.from('leads').delete().eq('id', tenderLead.id).eq('is_test', true);
    await admin.from('companies').delete().eq('id', co!.id);
    if (tenderCo) await admin.from('companies').delete().eq('id', tenderCo.id).eq('is_test', true);
    await admin.auth.admin.deleteUser(uid);
    await admin.from('workspaces').delete().eq('id', workspace);
    console.log('\ncleaned up the probe user, its workspace and everything it created');
  }
  console.log(failures === 0 ? 'smoke: all flows passed' : `smoke: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
