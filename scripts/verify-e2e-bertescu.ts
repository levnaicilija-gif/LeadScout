/**
 * Drive Verify exactly as a recruiter does: sign in to the deployment in a real browser, drop
 * a PDF into each tab, and report the network responses and the rendered result card.
 *
 *   npx tsx --env-file=.env.local scripts/verify-e2e.ts https://leadscout-rfbt.vercel.app
 *
 * Uses a throwaway account and deletes it (and everything it created) afterwards.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const EMAIL = `verify-e2e+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = 'probe-password-0123456789';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

(async () => {
  const { data: created, error } = await admin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
    user_metadata: { name: 'Verify E2E', agency: 'Verify E2E Agency' },
  });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  console.log(`probe user ${EMAIL}\nworkspace ${workspace}\n`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('response', async (r) => {
      const u = r.url();
      if (!/\/api\/(verify|anonymize)/.test(u)) return;
      let body = '';
      try { body = (await r.text()).slice(0, 240).replace(/\s+/g, ' '); } catch { body = '(unreadable)'; }
      console.log(`   NET ${r.status()} ${r.request().method()} ${u.replace(BASE, '')}\n       ${body}`);
    });
    page.on('console', (m) => { if (m.type() === 'error') console.log('   BROWSER ERROR: ' + m.text().slice(0, 160)); });

    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});

    // Supabase rate-limits sign-ins per IP; repeated probe runs trip it. Report what the page
    // actually said, wait, and try once more rather than failing on a locator timeout later.
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
      
      
      '.cache/repro/Bertescu_Dumitrel_CV_Final_Readable.pdf',
    ]);
    const started = Date.now();
    await page.waitForFunction(
      () => /recognised and handled/.test(document.body.innerText) && !/Reading |Checking |Preparing /.test(document.body.innerText),
      undefined, { timeout: 280000 },
    ).catch(() => console.log('   (still working after 280s)'));
    console.log(`   settled in ${Math.round((Date.now() - started) / 1000)}s`);
    await page.screenshot({ path: '.cache/repro/verify-bertescu.png', fullPage: true });
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
  } finally {
    await browser.close();
    const { data: cands } = await admin.from('candidates').select('id').eq('workspace_id', workspace);
    for (const c of cands ?? []) await admin.from('candidates').delete().eq('id', c.id);
    await admin.from('documents').delete().eq('workspace_id', workspace);
    await admin.auth.admin.deleteUser(uid);
    await admin.from('workspaces').delete().eq('id', workspace);
    console.log('cleaned up probe user, workspace and everything it created');
  }
})();
