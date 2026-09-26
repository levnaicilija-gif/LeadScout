/**
 * Item 16 on screen: Home's "Spent today" pill as a signed-in recruiter, at 1500px and at 390px on a touch screen.
 *
 *   npx tsx --env-file=.env.local scripts/spend-screen-probe.ts https://leadscout-rfbt.vercel.app
 *
 * The pill must show the spend counted against the cap, what recruiter tools spent of it, and test traffic beside it as
 * not counted — all read from cost_log across every workspace (`spentTodaySplit`). Spend can land while the page loads, so the database is read before and after
 * each page and the pill's figures must fall between the two. Passes when both widths show both figures, the recruiter
 * part is labelled as never stopped by the cap once the cap is reached, and the page never scrolls sideways.
 *
 * A throwaway account enters the real workspace as a recruiter following all industries and is removed afterwards with
 * its own test-marked workspace; a leftover fails the run. Writes nothing else, and presses nothing that calls a model.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe, probeAdmin } from '../src/lib/test-data';
import { spentTodaySplit, DAILY_BUDGET_EUR } from '../src/lib/cost';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const EMAIL = `spend-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = `probe-${Date.now()}-0123456789`;
const admin = probeAdmin();

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };
const within = (x: number, lo: number, hi: number) => x >= lo - 0.00005 && x <= hi + 0.00005;

async function readPill(p: Page, width: number) {
  const before = await spentTodaySplit(admin);
  await p.goto(`${BASE}/app/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForSelector('[data-pulse="spend"]', { timeout: 60000 }).catch(() => {});
  const pill = await p.evaluate(() => {
    const el = document.querySelector('[data-pulse="spend"]') as HTMLElement | null;
    return el ? { text: el.innerText.replace(/\s+/g, ' '), total: el.dataset.spendTotal, recruiter: el.dataset.spendRecruiter, test: el.dataset.spendTest, tone: el.dataset.tone, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 } : null;
  });
  const after = await spentTodaySplit(admin);
  if (!pill) { check(false, `Home at ${width}px has the spend pill`, p.url()); return; }
  const total = Number(pill.total), recruiter = Number(pill.recruiter);
  check(pill.total !== undefined && within(total, before.total, after.total), `at ${width}px the pill's total is the day's whole spend`, `pill €${pill.total}, database €${before.total.toFixed(4)}–€${after.total.toFixed(4)}`);
  check(pill.recruiter !== undefined && within(recruiter, before.recruiter, after.recruiter), `at ${width}px the pill's recruiter part is what recruiter tools spent`, `pill €${pill.recruiter}, database €${before.recruiter.toFixed(4)}–€${after.recruiter.toFixed(4)}`);
  check(pill.text.includes(`€${total.toFixed(2)}`) && pill.text.includes(`recruiter tools €${recruiter.toFixed(2)}`), `at ${width}px both figures are written on the pill`, pill.text);
  // Test traffic is kept out of the total and shown beside it (owner's decision 2026-09-15).
  const test = Number(pill.test);
  check(pill.test !== undefined && within(test, before.test, after.test), `at ${width}px the pill's test figure is today's test spend, kept out of the total`, `pill €${pill.test}, database €${before.test.toFixed(4)}–€${after.test.toFixed(4)}`);
  if (test >= 0.005) check(pill.text.includes(`test runs €${test.toFixed(2)}, not counted`), `at ${width}px test spend is written on the pill as not counted`, pill.text);
  if (total >= DAILY_BUDGET_EUR) check(/recruiter tools still run/.test(pill.text), `at ${width}px a spent cap says recruiter tools still run`, pill.text);
  check(!pill.sideways, `Home at ${width}px does not scroll sideways`);
  console.log(`  ...  ${width}px pill: "${pill.text}" (tone ${pill.tone})`);
}

(async () => {
  const { data: ws } = await admin.from('workspaces').select('id').eq('name', 'RFBT Recruitment').single();
  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Spend Probe', agency: 'Spend Probe' } });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: own } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const throwaway = own?.workspace_id as string;
  await markWorkspaceTest(admin, throwaway);
  await admin.from('users').update({ workspace_id: ws!.id, role: 'recruiter', onboarding_day: 30 }).eq('id', uid);
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
    check(/\/app\//.test(page.url()), 'signed in as a recruiter of the real workspace', page.url());
    await readPill(page, 1500);
    const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await readPill(await phone.newPage(), 390);
    await phone.close();
  } finally {
    await browser.close();
    const leftBehind = await removeProbe(admin, uid, throwaway, ws!.id);
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); } else console.log('\nprobe user and its workspace removed');
  }
  console.log(failures === 0 ? 'spend screen probe: all checks passed' : `spend screen probe: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
