/**
 * Item 11 part 3 on screen: the daily scorecard, on Settings, Today and Home, at 1500px and 390px.
 *
 * TWO PATHS, and the probe says which one it actually ran.
 *
 *   0039 NOT applied — every surface must render nothing at all and no error. That is the whole
 *     guarded-migration rule: a deploy can land before its schema, and a screen that names a table
 *     which is not there fails the WHOLE query, which has taken Leads, the drawer and Verify down.
 *   0039 applied — the six counts read, a line with no target shows the count alone and the card
 *     says so, the recruiter's three lines save and survive a reload, and a senior sees the day in
 *     the team list and can answer it.
 *
 * It refuses to claim the applied path was checked when the tables are not there; it reports which
 * path it took and passes only the assertions that path can honestly support.
 *
 *   npx tsx --env-file=.env.local scripts/scorecard-probe.ts http://localhost:3163
 */
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe, probeAdmin } from '../src/lib/test-data';

const BASE = process.argv[2] ?? 'http://localhost:3163';
const stamp = Date.now();
const admin = probeAdmin();
const shim = 'globalThis.__name = globalThis.__name || function (f) { return f; };';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const hydrated = (p: Page) => p.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', undefined, { timeout: 60000 }).catch(() => {});

/**
 * Wait for a client component that fetches before it renders.
 *
 * data-hydrated says React has hydrated the page; it says nothing about a component that returns
 * null until its own /api call resolves — which Scorecard, DailyTargets and TeamScorecards all do.
 * Counting at that moment reads 0 for a card that is about to appear, and the run then both denies
 * and quotes the same card (2026-09-16). innerText auto-waits, count() does not.
 */
const appears = async (p: Page, selector: string, ms = 30000) => {
  try {
    await p.waitForSelector(selector, { state: 'attached', timeout: ms });
    return true;
  } catch {
    return false;
  }
};
const sideways = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function account(label: string) {
  const email = `scorecard-probe-${label}+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: `Scorecard Probe ${label}`, agency: 'Scorecard Probe' } });
  if (error) throw new Error(`could not create the ${label}: ${error.message}`);
  const uid = data.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  await markWorkspaceTest(admin, me?.workspace_id);
  await followAllForProbe(admin, uid);
  return { uid, email, password, ownWorkspace: me?.workspace_id as string };
}

async function signIn(p: Page, a: { email: string; password: string }) {
  await p.addInitScript({ content: shim });
  await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.fill('input[type=email]', a.email);
  await p.fill('input[type=password]', a.password);
  await p.click('form button:not([type=button])');
  await p.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});
}

(async () => {
  // Asked directly, not through hasScorecards: that helper memoises a positive for the life of the
  // process and is written for the app's user client, and a probe must read the database as it is now.
  const { error: notThere } = await admin.from('scorecards').select('id').limit(1);
  const applied = !notThere;
  if (notThere && !/schema cache|does not exist/i.test(notThere.message)) {
    throw new Error(`could not tell whether 0039 is applied: ${notThere.code} ${notThere.message}`);
  }
  console.log(applied
    ? 'migration 0039 IS applied — checking the working scorecard'
    : 'migration 0039 is NOT applied — checking only that every surface degrades cleanly, which is all that can honestly be checked');

  const senior = await account('senior');
  const W = senior.ownWorkspace;
  await admin.from('users').update({ role: 'senior', onboarding_day: 30 }).eq('id', senior.uid);

  const browser = await chromium.launch();
  try {
    // A target on one line only, so the card must show "N of M" there and the bare count elsewhere —
    // the distinction the whole tone rule rests on, and unproven until something sets one.
    if (applied) {
      const { error } = await admin.from('scorecard_targets').insert({
        workspace_id: W, user_id: null, packs_prepared: 5, set_by: senior.uid,
      });
      if (error) throw new Error(`seeding a target failed: ${error.message}`);
    }

    for (const width of [1500, 390] as const) {
      console.log(`\n--- ${width}px ---`);
      const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, hasTouch: width === 390, isMobile: width === 390 });
      const p = await ctx.newPage();
      await signIn(p, senior);

      // ---------------------------------------------------------------- Settings
      await p.goto(`${BASE}/app/settings`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(p);
      const errorBoundary = await p.locator('[data-error-boundary]').count();
      check(errorBoundary === 0, 'Settings renders — no error boundary', `boundaries: ${errorBoundary}`);
      const targets = p.locator('[data-daily-targets]');
      if (applied) {
        check(await appears(p, '[data-daily-targets]'), 'Settings carries the Daily targets card');
        const fields = await p.locator('[data-target]').count();
        check(fields === 6, 'six target fields, one per counted thing', `${fields}`);
        const placeholder = await p.locator('[data-target="packs_prepared"]').getAttribute('placeholder');
        check(placeholder === 'not measured', 'an empty target reads "not measured", never 0', String(placeholder));
        check(await p.locator('[data-team-scorecards]').count() + await p.getByText('Nobody has written up a day yet.').count() > 0,
          'the team\'s days are listed, or it says nobody has written one');
      } else {
        check(await targets.count() === 0, 'with 0039 unapplied Settings carries no targets card, and does not fail');
      }

      // ---------------------------------------------------------------- Today
      await p.goto(`${BASE}/app/today`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(p);
      check(await p.locator('[data-error-boundary]').count() === 0, 'Today renders — no error boundary');
      // The hour is the BROWSER's, because ScorecardAfter reads it there — Node's may differ.
      const browserHour = await p.evaluate(() => new Date().getHours());
      const onToday = applied && browserHour >= 16 ? await appears(p, '[data-scorecard]') : await p.locator('[data-scorecard]').count() > 0;
      if (!applied) {
        check(onToday === false, 'with 0039 unapplied Today carries no scorecard, and does not fail');
      } else if (browserHour >= 16) {
        check(onToday, `after 16:00 Today carries the day's scorecard (browser hour ${browserHour})`);
        const lines = await p.locator('[data-scorecard-lines] li').count();
        check(lines === 6, 'six lines, one per counted thing', `${lines}`);
        const noTargets = await p.locator('[data-no-targets]').count();
        const text = flat(await p.locator('[data-scorecard]').innerText());
        check(!/0 of 0/.test(text), 'it never reads "0 of 0"', text.slice(0, 120));
        check(!/(great|good|well done|nice|solid|progress|keep it up)/i.test(text),
          'no praise and no encouragement — counts only', text.slice(0, 160));
        if (noTargets) check(/not measured against anything/.test(text), 'with no targets set it says so plainly');
        // One target set, five not: the measured line reads "N of 5", the rest read a bare count.
        check(/0 of 5/.test(text), 'a line with a target reads as a comparison, "0 of 5"', text.slice(0, 160));
        check(/CVs sent 0(?! of)/.test(text), 'a line with no target reads as the count alone', text.slice(0, 200));
      } else {
        check(onToday === false, 'before 16:00 Today does not carry it yet', `browser hour ${browserHour}`);
      }

      // ---------------------------------------------------------------- Home
      await p.goto(`${BASE}/app/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(p);
      check(await p.locator('[data-error-boundary]').count() === 0, 'Home renders — no error boundary');
      const onHome = applied ? await appears(p, '[data-scorecard]') : await p.locator('[data-scorecard]').count() > 0;
      check(applied ? onHome : !onHome,
        applied ? 'Home carries yesterday\'s scorecard' : 'with 0039 unapplied Home carries no scorecard, and does not fail', `${onHome}`);
      if (applied) {
        const head = flat(await p.locator('[data-scorecard]').innerText());
        check(/^Yesterday/.test(head), 'and it is labelled as yesterday, not today', head.slice(0, 60));
      }

      const over = await sideways(p);
      check(over <= 1, `at ${width}px nothing scrolls sideways`, `${over}px`);
      await ctx.close();
    }

    // ------------------------------------------------- the words a person writes, and that they last
    if (applied) {
      console.log('\n--- what a person writes ---');
      const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
      const p = await ctx.newPage();
      await signIn(p, senior);
      await p.goto(`${BASE}/app/today`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(p);
      // Decided by what the browser's clock says, never inferred from an element that has not
      // rendered yet: the first version printed "before 16:00" at 19:40 because it read a racing
      // count() and then stated a reason it had never checked (2026-09-16).
      const hourHere = await p.evaluate(() => new Date().getHours());
      const box = p.locator('[data-scorecard-notes]');
      const there = await appears(p, '[data-scorecard-notes]');
      if (!there) {
        check(hourHere < 16, `the write-up box is absent, and it is before 16:00 (browser hour ${hourHere})`);
      } else {
        const written = `Probe wrote this at ${new Date().toISOString()}`;
        await box.fill(written);
        await p.getByRole('button', { name: /^(Save|Update)$/ }).click();
        await p.waitForTimeout(1500);
        await p.reload({ waitUntil: 'domcontentloaded' });
        await hydrated(p);
        const back = await p.locator('[data-scorecard-notes]').inputValue();
        check(back === written, 'the three lines a recruiter writes survive a reload', back.slice(0, 80));
        const { data: row } = await admin.from('scorecards').select('notes, submitted_at').eq('workspace_id', W).eq('user_id', senior.uid).maybeSingle();
        check(row?.notes === written && !!row?.submitted_at, 'and they are in the database, with the time they were written');
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    const mine: string[] = [];
    for (const t of ['scorecards', 'scorecard_targets'] as const) {
      const { error } = await admin.from(t).delete().eq('workspace_id', W);
      if (error && !/schema cache|does not exist/i.test(error.message)) mine.push(`${t}: ${error.message}`);
    }
    const left = [...mine, await removeProbe(admin, senior.uid, W, null, { clearContent: true })].filter(Boolean).join('; ');
    console.log(left ? `\ncleanup left something behind: ${left}` : '\nthe probe workspace, its account and everything seeded were removed');
    if (left) failures++;
  }

  console.log(failures ? `\nscorecard probe: ${failures} FAILED` : `\nscorecard probe: all checks passed (${applied ? '0039 applied' : '0039 NOT applied — the working scorecard is still unverified'})`);
  process.exit(failures ? 1 : 0);
})();
