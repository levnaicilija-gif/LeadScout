/**
 * Diagnoses the /login -> /app/today hop against a deployed URL with a throwaway user.
 *   npx tsx --env-file=.env.local scripts/login-probe.ts https://leadscout-rfbt.vercel.app
 * Creates the user, drives the real browser flow, prints cookies + the redirect chain,
 * then deletes the user and the workspace its sign-up trigger created.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const EMAIL = `login-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = 'probe-password-0123456789';

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

(async () => {
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
    user_metadata: { name: 'Login Probe', agency: 'Login Probe Agency' },
  });
  if (cErr) { console.error('could not create probe user:', cErr.message); process.exit(1); }
  const uid = created.user!.id;
  console.log('probe user', EMAIL, uid);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const chain: string[] = [];
    page.on('response', (r) => {
      const s = r.status();
      if (s >= 300 && s < 400) chain.push(`${s} ${r.url()} -> ${r.headers()['location'] ?? ''}`);
      if (/\/app\/|\/login/.test(r.url()) && s >= 200) chain.push(`${s} ${r.request().method()} ${r.url()}`);
    });

    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('button[type=submit], form button:not([type=button])');
    await page.waitForTimeout(6000);

    const cookies = await page.context().cookies();
    console.log('\n--- cookies after sign-in');
    for (const c of cookies) console.log(`  ${c.name}  len=${c.value.length} domain=${c.domain} path=${c.path} httpOnly=${c.httpOnly} sameSite=${c.sameSite} secure=${c.secure}`);
    console.log('\n--- document.cookie names visible to JS');
    console.log('  ' + (await page.evaluate(() => document.cookie.split(';').map((c) => c.trim().split('=')[0]).join(', '))));
    console.log('\n--- request chain');
    chain.forEach((c) => console.log('  ' + c));
    console.log('\n--- final');
    console.log('  url  :', page.url());
    console.log('  error:', await page.evaluate(() => (document.querySelector('.text-bad') as HTMLElement)?.innerText ?? '(none)'));

    // Does the session cookie work on a fresh, full page load?
    await page.goto(`${BASE}/app/today`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    console.log('  hard nav to /app/today ->', page.url());
  } finally {
    await browser.close();
    const { data: u } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
    await admin.auth.admin.deleteUser(uid);
    if (u?.workspace_id) await admin.from('workspaces').delete().eq('id', u.workspace_id);
    console.log('\ncleaned up probe user and workspace', u?.workspace_id ?? '(none)');
  }
})();
