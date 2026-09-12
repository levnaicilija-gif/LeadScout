/**
 * Read a screen the way a signed-in recruiter sees it, in the real workspace.
 *
 * A service-role query proves what is in the database and nothing about what the product shows:
 * Hiring now sat empty over forty rows for days while every query I ran returned them. So when
 * the question is "what does the screen say", it has to be answered by the screen.
 *
 * A throwaway user is put into the real workspace, the page is read, and the user is deleted.
 * Nothing else in the workspace is touched.
 *
 *   npx tsx --env-file=.env.local scripts/screen-probe.ts "/app/radar?tab=hiring"
 */
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { markWorkspaceTest } from '../src/lib/test-data';

const BASE = process.env.SCREEN_BASE ?? 'https://leadscout-rfbt.vercel.app';
const PATH = process.argv[2] ?? '/app/radar?tab=hiring';
const EMAIL = `screen+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = 'probe-password-0123456789';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

(async () => {
  // The real workspace is the one with the candidates in it, not one of the probe leftovers.
  const { data: ws } = await admin.from('workspaces').select('id, name').order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!ws) { console.error('no workspace'); process.exit(1); }

  const { data: created, error } = await admin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
    user_metadata: { name: 'Screen Probe', agency: 'Screen Probe' },
  });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;

  // The sign-up trigger gives every user their own workspace; move this one into the real one so
  // the screen renders the real data under real RLS.
  const { data: own } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const throwaway = own?.workspace_id as string;
  await markWorkspaceTest(admin, throwaway);
  await admin.from('users').update({ workspace_id: ws.id, role: 'senior' }).eq('id', uid);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});
    if (!/\/app\//.test(page.url())) throw new Error('could not sign in');

    await page.goto(`${BASE}${PATH}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    console.log(`--- ${PATH} as a signed-in user of "${ws.name ?? ws.id}" ---\n`);
    console.log(await page.locator('body').innerText());
    await page.screenshot({ path: '.cache/screen.png', fullPage: true });
  } finally {
    await browser.close();
    await admin.auth.admin.deleteUser(uid);
    if (throwaway && throwaway !== ws.id) await admin.from('workspaces').delete().eq('id', throwaway);
    console.log('\n(probe user removed; the workspace was not otherwise touched)');
  }
})();
