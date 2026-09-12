/**
 * Screen-check every page as a signed-in recruiter, at desktop and at 390px.
 *
 * The same throwaway-user trick as screen-probe.ts: a real user, in the real workspace, under
 * real RLS — a restyle that looks right in a service-role dump and wrong to a recruiter is not
 * a restyle that shipped. Both widths are taken because the rail, the card grid and the
 * two-panel login all change shape between them.
 *
 *   SCREEN_BASE=http://localhost:3100 npx tsx --env-file=.env.local scripts/design-shots.ts
 */
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { markWorkspaceTest } from '../src/lib/test-data';
import fs from 'node:fs';

const BASE = process.env.SCREEN_BASE ?? 'https://leadscout-rfbt.vercel.app';
const OUT = process.env.SHOT_DIR ?? '.cache/shots';
const EMAIL = `shots+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = 'probe-password-0123456789';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const SIGNED_OUT = [['login', '/login'], ['signup', '/signup']];
const SIGNED_IN = [
  ['home', '/app/home'], ['today', '/app/today'], ['leads-won', '/app/radar'],
  ['leads-hiring', '/app/radar?tab=hiring'], ['verify', '/app/verify'], ['pitch', '/app/pitch'],
  ['candidates', '/app/candidates'], ['campaigns', '/app/campaigns'], ['settings', '/app/settings'],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { data: ws } = await admin.from('workspaces').select('id, name').order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!ws) { console.error('no workspace'); process.exit(1); }

  const { data: created, error } = await admin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
    user_metadata: { name: 'Design Shots', agency: 'Design Shots' },
  });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: own } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const throwaway = own?.workspace_id as string;
  await markWorkspaceTest(admin, throwaway);
  await admin.from('users').update({ workspace_id: ws.id, role: 'senior', onboarding_day: 30 }).eq('id', uid);

  const browser = await chromium.launch();
  const problems: string[] = [];
  try {
    for (const [width, tag] of [[1600, 'desktop'], [390, 'mobile']] as const) {
      const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1200 }, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => problems.push(`${tag}: page error — ${e.message}`));

      for (const [name, path] of SIGNED_OUT) {
        await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 60000 });
        await page.screenshot({ path: `${OUT}/${tag}-${name}.png`, fullPage: true });
        console.log(`${tag} ${name}`);
      }

      await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.fill('input[type=email]', EMAIL);
      await page.fill('input[type=password]', PASSWORD);
      await page.click('form button:not([type=button])');
      await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});
      if (!/\/app\//.test(page.url())) { problems.push(`${tag}: could not sign in`); await ctx.close(); continue; }

      for (const [name, path] of SIGNED_IN) {
        await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(700);
        const text = await page.locator('body').innerText();
        if (/Application error|Unhandled Runtime Error/i.test(text)) problems.push(`${tag} ${name}: the page rendered an error`);
        // A page wider than its viewport is a restyle bug, not a long table: tables scroll inside.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 2) problems.push(`${tag} ${name}: page scrolls sideways by ${overflow}px`);
        await page.screenshot({ path: `${OUT}/${tag}-${name}.png`, fullPage: true });
        console.log(`${tag} ${name}${overflow > 2 ? `  ← ${overflow}px sideways` : ''}`);
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    await admin.auth.admin.deleteUser(uid);
    if (throwaway && throwaway !== ws.id) await admin.from('workspaces').delete().eq('id', throwaway);
  }
  console.log(problems.length ? `\nPROBLEMS\n${problems.map((p) => '  ' + p).join('\n')}` : '\nno problems found');
})();
