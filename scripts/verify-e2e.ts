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
    console.log('signed in ->', page.url(), '\n');

    for (const [label, tab, file] of [
      ['CV ANONYMIZER', 'vcv', 'fixtures/test-cv.pdf'],
      ['CERTIFICATE CHECK', 'vcert', 'fixtures/test-certificate.pdf'],
    ] as const) {
      console.log(`=== ${label} =====================================================`);
      await page.goto(`${BASE}/app/verify`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1200);

      // The CV anonymizer sits behind the second tab.
      if (tab === 'vcv') {
        const t = page.locator('button, .tab, a').filter({ hasText: /cv|anonymi/i }).first();
        if (await t.count()) { await t.click().catch(() => {}); await page.waitForTimeout(600); }
      }

      const input = page.locator('input[type=file]').first();
      await input.setInputFiles(file);

      const started = Date.now();
      // Wait for either a result card or an error card — never longer than the UI's own bound.
      await page.waitForFunction(
        () => {
          const t = document.body.innerText;
          return /Anonymized CV ready|CV read|Valid|Read as|Not found|No online register|Retake needed|Expired or invalid|Read —|That did not work|^Read$/m.test(t) && !/Reading the|Checking the|Preparing the/.test(t);
        },
        undefined,
        { timeout: 150_000 },
      ).catch(() => console.log('   (no terminal state within 150s)'));
      const took = Math.round((Date.now() - started) / 1000);

      const shot = `fixtures/${tab}-result.png`;
      await page.screenshot({ path: shot, fullPage: true });
      const card = await page.evaluate(() => {
        const panels = [...document.querySelectorAll('.bg-panel')].map((e) => (e as HTMLElement).innerText.trim()).filter((t) => t.length > 40);
        return panels.slice(-3).join('\n---\n');
      });
      console.log(`   settled in ${took}s · screenshot ${shot}\n`);
      console.log(card.split('\n').map((l) => '   | ' + l).join('\n'));
      console.log('');
    }
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
