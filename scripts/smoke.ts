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

  console.log(`smoke test against ${BASE}\n`);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));

    // 1 — sign in
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});
    check(/\/app\//.test(page.url()), 'sign in', page.url().replace(BASE, ''));
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
      await page.locator('input[type=file]').first().setInputFiles([CV]);
      await page.waitForFunction(
        () => /recognised and handled/.test(document.body.innerText) && !/Reading |Checking |Preparing /.test(document.body.innerText),
        undefined, { timeout: 280000 },
      ).catch(() => {});
      const verify = await bodyOf(page);
      check(/recognised and handled/.test(verify), 'Verify accepts and handles an upload');
      check(!/could not be prepared/.test(verify), 'Verify prepared the client version');
    }

    check(pageErrors.length === 0, 'no uncaught client errors', pageErrors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    const { data: cands } = await admin.from('candidates').select('id').eq('workspace_id', workspace);
    for (const c of cands ?? []) await admin.from('candidates').delete().eq('id', c.id);
    await admin.from('documents').delete().eq('workspace_id', workspace);
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
