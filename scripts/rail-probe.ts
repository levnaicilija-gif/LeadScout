/**
 * Signs in as a throwaway senior user and dumps the left rail from /app/today, to see what
 * the recruiter actually gets. Deletes the user afterwards.
 *   npx tsx --env-file=.env.local scripts/rail-probe.ts https://leadscout-rfbt.vercel.app
 */
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { markWorkspaceTest, removeProbe, probeAdmin } from '../src/lib/test-data';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const EMAIL = `rail-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = 'probe-password-0123456789';
const admin = probeAdmin();

(async () => {
  const { data: created, error } = await admin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
    user_metadata: { name: 'Rail Probe', agency: 'Rail Probe Agency' },
  });
  if (error) { console.error(error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: row } = await admin.from('users').select('role, onboarding_day').eq('id', uid).maybeSingle();
  console.log('probe user role =', JSON.stringify(row));

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 620 } });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('form button:not([type=button])');
    await page.waitForTimeout(7000);
    console.log('landed on', page.url());

    const rail = await page.evaluate(() => {
      const nav = document.querySelector('nav');
      if (!nav) return { found: false } as any;
      return {
        found: true,
        text: (nav as HTMLElement).innerText,
        links: Array.from(nav.querySelectorAll('a')).map((a) => `${a.getAttribute('href')} → "${(a as HTMLElement).innerText.replace(/\s+/g, ' ').trim()}"`),
        signOut: /sign ?out|log ?out/i.test((nav as HTMLElement).innerText),
      };
    });
    console.log('rail found:', rail.found);
    if (rail.found) {
      console.log('rail links:\n  ' + rail.links.join('\n  '));
      console.log('has Settings:', /settings/i.test(rail.text));
      console.log('has Sign out:', rail.signOut);
      const vis = await page.evaluate(() => { const a=[...document.querySelectorAll('nav a')].find(x=>/settings/i.test(x.textContent||'')); if(!a) return 'not in DOM'; const r=a.getBoundingClientRect(); const nav=document.querySelector('nav')!.getBoundingClientRect(); return JSON.stringify({linkTop:Math.round(r.top),linkBottom:Math.round(r.bottom),navBottom:Math.round(nav.bottom),viewportH:innerHeight,clipped:r.bottom>innerHeight||r.bottom>nav.bottom}); });
      console.log('settings link geometry:', vis);
    }
  } finally {
    await browser.close();
    const { data: u } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
    // Its own workspace, made for this new user at signup: marked as test data, then removed with both deletes read.
    if (u?.workspace_id) await markWorkspaceTest(admin, u.workspace_id);
    const leftBehind = await removeProbe(admin, uid, u?.workspace_id);
    if (leftBehind) { console.log(`\nCLEANUP FAILED — ${leftBehind}`); process.exitCode = 1; }
    else console.log('cleaned up');
  }
})();
