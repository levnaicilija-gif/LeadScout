/**
 * The friendly error page, on screen, as a signed-in recruiter at 1500px and at 390px on a touch screen.
 *
 *   npx tsx --env-file=.env.local scripts/error-boundary-probe.ts https://leadscout-rfbt.vercel.app
 *
 * The sign-in outage that exposed the bare "Application error" page cannot be summoned on demand, so /app/error-check
 * fails on purpose — for an account in a test workspace only; anyone else gets a 404. It throws inside the same /app
 * layout requireUser runs in, and goes through the same boundary. Passes when:
 *   - the page says "Something went wrong — reload the page", with a Reload button, a way Home and the error's reference,
 *     and never Next's "Application error";
 *   - Reload really reloads (the error is deliberate, so the same page comes back);
 *   - neither width scrolls sideways, and Today, which works, shows no error page;
 *   - an account in the real workspace gets a 404 from /app/error-check, not a failure.
 *
 * A throwaway account with its own test-marked workspace, moved into the real workspace for the 404 check only; it and
 * its workspace are removed afterwards and a leftover fails the run.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe } from '../src/lib/test-data';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const EMAIL = `error-boundary-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = `probe-${Date.now()}-0123456789`;
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };

async function errorPage(page: Page, width: number) {
  const res = await page.goto(`${BASE}/app/error-check`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-error-boundary]', { timeout: 60000 }).catch(() => {});
  const seen = await page.evaluate(() => {
    const box = document.querySelector('[data-error-boundary]') as HTMLElement | null;
    const reload = [...document.querySelectorAll('button')].find((b) => /reload the page/i.test(b.innerText)) as HTMLElement | undefined;
    const r = reload?.getBoundingClientRect();
    return {
      boundary: !!box,
      heading: (document.querySelector('[data-error-boundary] h1') as HTMLElement | null)?.innerText ?? '',
      text: document.body.innerText.replace(/\s+/g, ' '),
      reloadVisible: !!r && r.width > 0 && r.height > 0 && r.right <= document.documentElement.clientWidth,
      home: !!document.querySelector('[data-error-boundary] a[href="/app/home"]'),
      reference: (document.querySelector('[data-error-reference]') as HTMLElement | null)?.innerText ?? '',
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  await page.screenshot({ path: `.cache/error-boundary-${width}.png`, fullPage: true }).catch(() => {});
  check(seen.boundary && seen.heading === 'Something went wrong — reload the page', `at ${width}px a failing screen says "Something went wrong — reload the page"`, `HTTP ${res?.status()} · heading "${seen.heading}"`);
  check(!/Application error|server-side exception/i.test(seen.text), `at ${width}px Next's bare "Application error" is not shown`, seen.text.slice(0, 120));
  check(seen.reloadVisible && seen.home, `at ${width}px the Reload button is on screen, with a way back to Home`);
  check(/^Reference: \S+/.test(seen.reference), `at ${width}px the error's reference is shown, so a repeat can be traced`, seen.reference);
  check(seen.sideways <= 1, `at ${width}px the error page does not scroll sideways`, `${seen.sideways}px`);

  const reloaded = page.waitForEvent('load', { timeout: 60000 }).then(() => true).catch(() => false);
  await page.locator('[data-error-boundary] button', { hasText: 'Reload the page' }).click();
  const didReload = await reloaded;
  await page.waitForSelector('[data-error-boundary]', { timeout: 60000 }).catch(() => {});
  check(didReload && (await page.locator('[data-error-boundary]').count()) === 1, `at ${width}px Reload reloads the page (the failure is deliberate, so it comes back)`);
}

(async () => {
  const { data: realWs } = await admin.from('workspaces').select('id').eq('name', 'RFBT Recruitment').single();
  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Error Boundary Probe', agency: 'Error Boundary Probe' } });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: own } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const throwaway = own?.workspace_id as string;
  await markWorkspaceTest(admin, throwaway);
  await admin.from('users').update({ role: 'recruiter', onboarding_day: 30 }).eq('id', uid);
  const followProblem = await followAllForProbe(admin, uid);
  if (followProblem) console.log(`  ...  ${followProblem}`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});
    check(/\/app\//.test(page.url()), 'signed in as a recruiter in a test workspace', page.url());

    await errorPage(page, 1500);
    const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const m = await phone.newPage();
    await errorPage(m, 390);

    // A screen that works shows no error page.
    await page.goto(`${BASE}/app/today`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.body.innerText.length > 60, undefined, { timeout: 60000 }).catch(() => {});
    check((await page.locator('[data-error-boundary]').count()) === 0, 'Today, which works, shows no error page');

    // Outside a test workspace the deliberate failure does not exist.
    await admin.from('users').update({ workspace_id: realWs!.id }).eq('id', uid);
    const res = await page.goto(`${BASE}/app/error-check`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const real = await page.evaluate(() => ({ boundary: !!document.querySelector('[data-error-boundary]'), text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 120) }));
    check(res?.status() === 404 && !real.boundary, 'an account in the real workspace gets a 404 from /app/error-check, not a failure', `HTTP ${res?.status()} · ${real.text}`);
    await phone.close();
  } finally {
    await browser.close();
    const leftBehind = await removeProbe(admin, uid, throwaway, realWs!.id);
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); } else console.log('\nprobe user and its workspace removed');
  }
  console.log(failures === 0 ? 'error boundary probe: all checks passed' : `error boundary probe: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
