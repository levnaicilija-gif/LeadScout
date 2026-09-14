/**
 * Item 18 part 3 — a new person's first sign-in, walked through on the real workspace's data.
 *
 *   npx tsx --env-file=.env.local scripts/first-signin-walkthrough.ts https://leadscout-rfbt.vercel.app
 *
 * For each width (1280px, then 390px on a touch screen) a fresh throwaway account — its own workspace marked
 * is_test — joins the real workspace as a recruiter with no industries chosen, like the RLS sweep's account, and is
 * removed at the end. A choice once made cannot be cleared (0032), so each width starts from a new account rather
 * than a reset. After every step the account's stored choice is read back from the database, so a screen that
 * disagrees with what is stored shows which one moved. Screenshots go to .cache/shots-first-signin. Exits 1 on any
 * empty or broken screen, or a leftover.
 */
import fs from 'fs';
import { chromium, type Browser, type Page } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { markWorkspaceTest, removeProbe } from '../src/lib/test-data';

const BASE = process.argv[2] ?? 'https://leadscout-rfbt.vercel.app';
const SHOTS = '.cache/shots-first-signin';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const PASSWORD = 'probe-password-0123456789';
let failed = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failed++; console.log(`${ok ? '  PASS' : '  FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };
const text = (p: Page, sel: string) => p.locator(sel).first().innerText().catch(() => '');
const hydrated = (p: Page) => p.waitForSelector('html[data-hydrated="true"]', { state: 'attached', timeout: 60000 }).catch(() => {});

async function stored(uid: string, step: string) {
  const { data, error } = await admin.from('users').select('industry_follow, industry_follow_set_by, industry_follow_set_at').eq('id', uid).single();
  const by = !data?.industry_follow_set_by ? 'nobody' : data.industry_follow_set_by === uid ? 'the account itself' : `another user ${data.industry_follow_set_by}`;
  console.log(`      stored after ${step}: ${error ? `could not read: ${error.message}` : `${JSON.stringify(data?.industry_follow)} set by ${by} at ${data?.industry_follow_set_at ?? '—'}`}`);
  return data;
}

async function newAccount(realId: string, width: number) {
  const email = `first-signin-${width}+${Date.now()}@rfbt-recruitment.com`;
  const { data: created, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { name: `First Sign-in ${width}`, agency: `First Sign-in ${width}` } });
  if (error || !created.user) throw new Error(`could not create the ${width}px account: ${error?.message}`);
  const uid = created.user.id;
  const { data: own, error: ownErr } = await admin.from('users').select('workspace_id, industry_follow').eq('id', uid).single();
  if (ownErr || !own) throw new Error(`the ${width}px account has no users row: ${ownErr?.message}`);
  await markWorkspaceTest(admin, own.workspace_id);
  const { error: moveErr } = await admin.from('users').update({ workspace_id: realId, role: 'recruiter' }).eq('id', uid);
  if (moveErr) throw new Error(`the ${width}px account could not join the real workspace: ${moveErr.message}`);
  return { uid, email, throwaway: own.workspace_id as string, startedWith: own.industry_follow };
}

async function walk(browser: Browser, width: number, realId: string) {
  const tag = `${width}px`;
  console.log(`\n— at ${tag}`);
  const acct = await newAccount(realId, width);
  try {
    const context = width < 500
      ? await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true })
      : await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const shot = (name: string) => page.screenshot({ path: `${SHOTS}/${tag}-${name}.png`, fullPage: true }).catch(() => {});
    check(acct.startedWith == null, `${tag}: a new account starts with nothing chosen`, JSON.stringify(acct.startedWith));

    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', acct.email);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});
    await page.waitForSelector('[data-industry-choice]', { timeout: 60000 }).catch(() => {});
    await hydrated(page);
    const options = await page.$$eval('[data-option]', (els) => els.map((e) => ({ id: e.getAttribute('data-option'), text: (e as HTMLElement).innerText.replace(/\s+/g, ' ') })));
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    await shot('1-onboarding');
    check(/\/app\/onboarding/.test(page.url()), `${tag}: signing in lands on "Which industries do you work in?"`, page.url().replace(BASE, ''));
    check(options.length === 17 && options.some((o) => o.id === 'wind') && !options.some((o) => o.id === 'offshore_wind'), `${tag}: 16 industries (Wind as one) plus "All industries", each with what is on file`, options.slice(0, 4).map((o) => o.text).join(' | '));
    check(!(await page.locator('text=/skip/i').count()), `${tag}: there is no skip`);
    check(!sideways, `${tag}: no sideways scroll`);

    await page.goto(`${BASE}/app/radar`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    check(/\/app\/onboarding/.test(page.url()), `${tag}: Leads sends an unchosen account back to onboarding`, page.url().replace(BASE, ''));
    await page.goto(`${BASE}/app/today`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    check(/\/app\/onboarding/.test(page.url()), `${tag}: Today does too`, page.url().replace(BASE, ''));

    await page.waitForSelector('[data-option="wind"] input', { timeout: 60000 });
    await hydrated(page);
    await page.locator('[data-option="wind"] input').check();
    await page.locator('[data-save-industries]').click();
    await page.waitForURL(/\/app\/radar/, { timeout: 60000 }).catch(() => {});
    await page.waitForSelector('[data-industry-view]', { timeout: 60000 }).catch(() => {});
    await stored(acct.uid, 'choosing Wind');
    const banner = await text(page, '[data-industry-view]');
    const rows = await page.$$eval('tr[data-lead-source]', (trs) => trs.map((t) => (t as HTMLElement).innerText.split('\n')[0]));
    const emptyLine = await text(page, 'tbody td[colspan]');
    await shot('2-leads-wind');
    check(/\/app\/radar/.test(page.url()), `${tag}: after choosing Wind, Leads opens straight away`, page.url().replace(BASE, ''));
    check(/your industries/.test(banner) && (rows.length > 0 || emptyLine.length > 0), `${tag}: Leads says it shows your industries and shows them — never a bare table`, `${banner.replace(/\s+/g, ' ')} · rows: ${rows.slice(0, 6).join(', ') || emptyLine}`);

    await page.locator('[data-show-all-industries]').first().click();
    await page.waitForURL(/industries=all/, { timeout: 60000 }).catch(() => {});
    await page.waitForSelector('tr[data-lead-source]', { timeout: 60000 }).catch(() => {});
    const allRows = await page.locator('tr[data-lead-source]').count();
    await shot('3-leads-all');
    await stored(acct.uid, 'showing all industries');
    check(/industries=all/.test(page.url()) && allRows > rows.length, `${tag}: "show all industries" is one click and shows more`, `${rows.length} → ${allRows} rows`);

    await page.goto(`${BASE}/app/radar?tab=hiring`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('tr[data-row-href]', { timeout: 60000 }).catch(() => {});
    await stored(acct.uid, 'opening Hiring now');
    const hiringBanner = await text(page, '[data-industry-view]');
    const hiringRows = await page.$$eval('tr[data-row-href]', (trs) => trs.map((t) => (t as HTMLElement).innerText.split('\n')[0]));
    await shot('4-hiring-wind');
    check(/your industries/.test(hiringBanner), `${tag}: Hiring now opens on your industries too`, `url ${page.url().replace(BASE, '')} · banner "${hiringBanner.replace(/\s+/g, ' ')}" · ${hiringRows.slice(0, 6).join(', ')}`);

    await page.goto(`${BASE}/app/today`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('main ol', { timeout: 60000 }).catch(() => {});
    const today = await text(page, 'main ol');
    await shot('5-today');
    check(/\/app\/today/.test(page.url()) && today.length > 0, `${tag}: Today opens`, today.replace(/\s+/g, ' ').slice(0, 220));

    await page.goto(`${BASE}/app/preferences`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('[data-following]', { timeout: 60000 }).catch(() => {});
    await stored(acct.uid, 'opening Preferences');
    const following = await text(page, '[data-following]');
    await shot('6-preferences');
    check(/Wind/.test(following), `${tag}: Preferences shows the choice, changeable`, following.replace(/\s+/g, ' '));

    await hydrated(page);
    await page.locator('[data-option="wind"] input').uncheck();
    await page.locator('[data-option="pharma_life_sciences"] input').check();
    const warned = await text(page, '[data-no-matches]');
    await page.locator('[data-save-industries]').click();
    await page.waitForURL(/saved=1/, { timeout: 60000 }).catch(() => {});
    await stored(acct.uid, 'choosing Pharma & Life Sciences');
    await page.goto(`${BASE}/app/radar`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('[data-industry-view]', { timeout: 60000 }).catch(() => {});
    const none = await text(page, '[data-no-followed-leads]');
    const noneShowAll = await page.locator('[data-no-followed-leads] a').count();
    await shot('7-leads-no-matches');
    check(warned.length > 0, `${tag}: choosing an industry with nothing on file is warned before saving`, warned);
    check(/No open leads in your industries/.test(none) && noneShowAll === 1, `${tag}: Leads then says so plainly, with every open lead one click away`, none.replace(/\s+/g, ' '));
    await context.close();
  } finally {
    const left = await removeProbe(admin, acct.uid, acct.throwaway, realId);
    if (left) { failed++; console.log(`  FAIL  ${tag} cleanup: ${left}`); }
  }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { data: real } = await admin.from('workspaces').select('id').eq('name', 'RFBT Recruitment').single();
  const browser = await chromium.launch();
  try {
    for (const width of [1280, 390]) {
      try { await walk(browser, width, real!.id); } catch (e: any) { failed++; console.log(`  FAIL  ${width}px could not finish: ${e.message ?? e}`); }
    }
  } finally {
    await browser.close();
    const { data: members } = await admin.from('users').select('role').eq('workspace_id', real!.id);
    console.log(`\nreal workspace members after: ${JSON.stringify(members)}`);
  }
  console.log(failed ? `first sign-in walk-through: ${failed} failed` : `first sign-in walk-through: every step held at both widths · screenshots in ${SHOTS}`);
  process.exitCode = failed ? 1 : 0;
})();
