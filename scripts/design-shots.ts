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
import { markWorkspaceTest, deleteTestWorkspace, followAllForProbe } from '../src/lib/test-data';
import fs from 'node:fs';

const BASE = process.env.SCREEN_BASE ?? 'https://leadscout-rfbt.vercel.app';
const OUT = process.env.SHOT_DIR ?? '.cache/shots';
const EMAIL = `shots+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = 'probe-password-0123456789';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const SIGNED_OUT = [['login', '/login'], ['signup', '/signup']];
const SIGNED_IN = [
  ['home', '/app/home'], ['today', '/app/today'], ['leads-won', '/app/radar'],
  ['leads-hiring', '/app/radar?tab=hiring'], ['verify', '/app/verify'], ['certificate', '/app/certificate'], ['pitch', '/app/pitch'],
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
  // From 0032 a new account chooses industries before any screen; this probe checks other screens, so it follows all.
  const followProblem = await followAllForProbe(admin, uid);
  if (followProblem) throw new Error(followProblem);
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
        // Since 2026-09-15 a failing screen shows src/app/error.tsx, not Next's text — matching only "Application error"
        // would let every broken screen through.
        const boundary = await page.locator('[data-error-boundary]').count();
        if (boundary > 0 || /Application error|Unhandled Runtime Error|Something went wrong — reload the page/i.test(text)) {
          // Say WHAT threw, not merely that something did (2026-09-18). error.tsx prints the digest on this
          // very page as "Reference: <digest>" (data-error-reference), and this check counted the boundary
          // and dropped it: on 2026-09-18 the gate failed with "mobile today: the page rendered an error"
          // (plus two cascades — a page showing a boundary has no "+ Add CV" button, so its count is 0 and
          // clicking it cannot open the picker) and the cause had to be dug out of next start's own log
          // afterwards, where it read "AuthRetryableFetchError 0", digests 273046742 and 1786437619.
          // The trigger is deliberately unchanged: the text arm fires on Next's own error pages, where
          // there is no [data-error-boundary] and so no reference to find, and a missing one must not
          // stop a broken screen failing the run. Same shape as today-probe's boundaryWhy.
          const ref = (await page.locator('[data-error-reference]').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
          const said = text.replace(/\s+/g, ' ').trim().slice(0, 120);
          problems.push(`${tag} ${name}: the page rendered an error — ${ref || 'no reference shown'} — ${said}`);
        }
        // A page wider than its viewport is a restyle bug, not a long table: tables scroll inside.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 2) problems.push(`${tag} ${name}: page scrolls sideways by ${overflow}px`);
        await page.screenshot({ path: `${OUT}/${tag}-${name}.png`, fullPage: true });
        console.log(`${tag} ${name}${overflow > 2 ? `  ← ${overflow}px sideways` : ''}`);

        // Item 24 follow-up: one way to add a CV at each width — the drop zone (the foot of the rail, or Home's card) at
        // desktop, the floating "+ Add CV" button at 390px — on every screen but Verify, which keeps its own drop zone.
        // Clicking it must open the file picker. No file is chosen: this runs in the real workspace, so nothing is read.
        const shown = (sel: string) => page.locator(sel).evaluateAll((els) => els.filter((e) => (e as any).checkVisibility()).length);
        const [zones, buttons] = [await shown('[data-cv-drop-zone]'), await shown('[data-candidate-drop-button]')];
        // Verify and Certificate check both stand aside: each has its own drop zone, so the rail's CV zone and the
        // floating "+ Add CV" button would be a second, confusing way in on a screen that already has one.
        const ownZone = name === 'verify' || name === 'certificate';
        const [wantZones, wantButtons] = ownZone ? [0, 0] : tag === 'desktop' ? [1, 0] : [0, 1];
        if (zones !== wantZones || buttons !== wantButtons) problems.push(`${tag} ${name}: ${zones} CV drop zone(s) and ${buttons} "+ Add CV" button(s) on screen, expected ${wantZones} and ${wantButtons}`);
        if (wantZones || wantButtons) {
          await page.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', undefined, { timeout: 30000 }).catch(() => {});
          const control = page.locator(wantZones ? '[data-cv-drop-zone]:visible' : '[data-candidate-drop-button]:visible').first();
          const picker = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), control.click()]).then(() => true).catch(() => false);
          if (!picker) problems.push(`${tag} ${name}: clicking the ${wantZones ? 'CV drop zone' : '"+ Add CV" button'} did not open the file picker`);
        }
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    // Both deletes are read now. The gate on 2026-09-13 left an empty "Design Shots" workspace behind
    // and nothing said so, because the answer to the workspace delete was never looked at.
    const { error: userError } = await admin.auth.admin.deleteUser(uid);
    if (userError) problems.push(`cleanup: the probe user ${uid} was not deleted: ${userError.message}`);
    const notDeleted = await deleteTestWorkspace(admin, throwaway, ws.id);
    if (notDeleted) problems.push(`cleanup: ${notDeleted}`);
  }
  console.log(problems.length ? `\nPROBLEMS\n${problems.map((p) => '  ' + p).join('\n')}` : '\nno problems found');
  // The release gate reads the exit code. Problems used to be printed and the script still exited 0,
  // so a page that scrolled sideways, rendered an error or could not sign in never failed the gate.
  process.exit(problems.length ? 1 : 0);
})();
