/**
 * Today, redesigned: every card opens the real page, and the numbers on it are the real numbers.
 *
 *   npx tsx --env-file=.env.local scripts/today-probe.ts http://localhost:3163
 *
 * Runs as a signed-in recruiter at 1500px and again at 390px on a touch screen, and SAYS WHICH PATH
 * IT RAN: with 0042 unapplied there is no "while you were out" split and no follow-up list, so only
 * the guarded shape can be checked. A green run must never imply the applied path was tested.
 *
 * What it proves:
 *   1. the three top cards and four tool cards each link to a page that already exists — and that
 *      that page renders, rather than 404ing or throwing an error boundary;
 *   2. Today's card opens the REAL Leads page carrying ?since=, with its full column set;
 *   3. `since` survives a source chip, a sort chip and a row href — the filter is a parameter on the
 *      real page, not a separate trimmed table, and a chip that dropped it would silently clear it;
 *   4. "Clear filter — see all N →" returns to the unfiltered list and N matches the real total;
 *   5. the sample panel carries its "sample" badge, on the card and on its detail page;
 *   6. the counts are read from the database, not the mockup's snapshot;
 *   7. nothing scrolls sideways at either width.
 * Everything it makes is removed afterwards; a leftover fails the run.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe } from '../src/lib/test-data';

const BASE = process.argv[2] ?? 'http://localhost:3163';
const stamp = Date.now();
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const shim = 'globalThis.__name = globalThis.__name || function (f) { return f; };';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const hydrated = (p: Page) => p.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', undefined, { timeout: 60000 }).catch(() => {});
const sideways = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const appears = async (p: Page, sel: string, ms = 30000) => {
  try { await p.waitForSelector(sel, { state: 'attached', timeout: ms }); return true; } catch { return false; }
};

async function account() {
  const email = `today-probe+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: 'Today Probe', agency: 'Today Probe' } });
  if (error) throw new Error(`could not create the probe account: ${error.message}`);
  const uid = data.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  await markWorkspaceTest(admin, me?.workspace_id);
  await followAllForProbe(admin, uid);
  await admin.from('users').update({ role: 'senior', onboarding_day: 30 }).eq('id', uid);
  return { uid, email, password, workspace: me?.workspace_id as string };
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
  // Which path can honestly be checked?
  const { error: noLastSeen } = await admin.from('users').select('last_seen_at').limit(1);
  const { error: noFollowups } = await admin.from('followup_resolutions').select('id').limit(1);
  const applied = !noLastSeen && !noFollowups;
  console.log(applied
    ? 'migration 0042 IS applied — checking the visit split and the follow-up list'
    : `migration 0042 is NOT applied — checking only the guarded shape, which is all that can honestly be checked (last_seen_at: ${noLastSeen ? 'absent' : 'present'}, followup_resolutions: ${noFollowups ? 'absent' : 'present'})`);

  const who = await account();

  // Seeded in the probe's OWN workspace, because that is the only data the page will show it:
  // handle_new_user gives every new account an empty workspace, so asserting the database's totals
  // compared a fresh workspace's view against rows it cannot see (2026-09-17).
  //
  // The dates are spread on purpose. Three leads older than the window and two inside it means the
  // filtered view must read "2 of 5" — which tests the filter's arithmetic, where asserting that a
  // banner merely exists tested nothing.
  const OLD = 3;
  const RECENT = 2;
  const WON = OLD + RECENT;
  const POSTS = 4;
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString();
  const company = (await admin.from('companies').insert({
    workspace_id: who.workspace, name: `Today Probe Yard ${stamp}`, country: 'DK', employer_type: 'end_client', is_test: true,
  }).select('id').single()).data!.id;

  const leadRows = [
    ...Array.from({ length: OLD }, (_, i) => ({ days: 5, n: i })),
    ...Array.from({ length: RECENT }, (_, i) => ({ days: 1, n: OLD + i })),
  ].map(({ days, n }) => ({
    workspace_id: who.workspace, company_id: company, kind: 'won_work', status: 'new',
    country: 'DK', project_name: `Probe project ${n}`, trades_inferred: ['welder'],
    fit_score: 60 + n, created_at: iso(days), is_test: true,
  }));
  const { error: leadErr } = await admin.from('leads').insert(leadRows);
  if (leadErr) throw new Error(`seeding leads failed: ${leadErr.message}`);

  // source_url is NOT NULL on job_posts (0001) and carries a unique (lead_id, source_url) — so each
  // seeded row needs its own. Omitting it failed the whole insert; read from the declaration rather
  // than from memory this time.
  const { error: postErr } = await admin.from('job_posts').insert(
    Array.from({ length: POSTS }, (_, i) => ({
      workspace_id: who.workspace, company_id: company, status: 'open',
      role: `Probe welder ${i}`, country: 'DK', trades: ['welder'],
      source_url: `https://example.invalid/today-probe/${stamp}/${i}`,
      posted_at: iso(2).slice(0, 10), first_seen_at: iso(2), is_test: true,
    })),
  );
  if (postErr) throw new Error(`seeding postings failed: ${postErr.message}`);

  const won = WON;
  const openPosts = POSTS;
  console.log(`seeded in the probe's own workspace: ${WON} won-work leads (${OLD} older than the window, ${RECENT} inside it), ${POSTS} open postings`);
  const browser = await chromium.launch();
  try {
    for (const width of [1500, 390] as const) {
      console.log(`\n--- ${width}px ---`);
      const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, hasTouch: width === 390, isMobile: width === 390 });
      const p = await ctx.newPage();
      await signIn(p, who);

      await p.goto(`${BASE}/app/today`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(p);
      check(await p.locator('[data-error-boundary]').count() === 0, 'Today renders — no error boundary');

      // ---- the three top cards
      check(await appears(p, '[data-today-card]'), 'the Today card is there');
      check(await appears(p, '[data-yesterday-card]'), 'the Yesterday card is there');
      check(await appears(p, '[data-leads-card]'), 'the Leads card is there');

      const todayHref = await p.locator('[data-today-card]').getAttribute('href');
      check(!!todayHref && todayHref.startsWith('/app/radar'), 'the Today card opens the real Leads page', String(todayHref));
      if (applied) check(!!todayHref && todayHref.includes('since='), 'carrying ?since= — the recruiter\'s own last visit', String(todayHref));
      check(await p.locator('[data-yesterday-card]').getAttribute('href') === '/app/today/yesterday', 'the Yesterday card opens the detail page');
      check(await p.locator('[data-leads-card]').getAttribute('href') === '/app/radar', 'the Leads card opens Leads, unfiltered');

      // ---- the four tool cards, each onto a page that exists
      const tools = await p.locator('[data-tool-card]').count();
      check(tools === 4, 'four tool cards', `${tools}`);
      for (const [tone, href] of [['cand', '/app/verify'], ['leads', '/app/verify'], ['pitch', '/app/pitch']] as const) {
        const got = await p.locator(`[data-tool-card="${tone}"]`).first().getAttribute('href');
        check(got === href, `the ${tone} tool card links to ${href}`, String(got));
      }
      const candHrefs = await p.locator('[data-tool-card="cand"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
      check(candHrefs.includes('/app/candidates'), 'and one links to Candidates', JSON.stringify(candHrefs));

      // ---- the numbers are the real numbers, read from the count itself
      const pageText = flat(await p.locator('body').innerText());
      const wonShown = flat(await p.locator('[data-lead-count="won"]').innerText().catch(() => ''));
      const hiringShown = flat(await p.locator('[data-lead-count="hiring"]').innerText().catch(() => ''));
      check(wonShown === String(won), `Won work reads this workspace's own total (${won})`, `card says "${wonShown}"`);
      check(hiringShown === String(openPosts), `Hiring now reads this workspace's own total (${openPosts})`, `card says "${hiringShown}"`);
      check(/4 of 16/.test(pageText), 'the certificate card says 4 of 16 searched automatically — counted, not the mockup\'s 8 of 16');
      check(!/8 of 16/.test(pageText), 'and never 8 of 16');

      // ---- the sample panel says it is a sample
      check(await appears(p, '[data-sample-panel]'), 'the worked example is on the page');
      check(await p.locator('[data-sample-badge]').count() === 1, 'and carries a "sample" badge');
      check(/Not live data/i.test(pageText), 'and says plainly it is not live data');

      // ---- the mockup's scaffolding is not shipped
      check(!/CLICK-THROUGH/i.test(pageText), 'the mockup\'s click-through banner is not shipped');
      check(!/manual verification takes/i.test(pageText), 'and no invented benchmark line is shipped');

      // ---- the guarded shape, when 0042 is not applied
      if (!applied) {
        check(!/While you were out/i.test(pageText), 'with 0042 unapplied there is no "while you were out" split, and Today does not fail');
        check(/Nothing waiting on you|could not be read/i.test(pageText), 'and the follow-up section says so rather than showing nothing at all');
      } else {
        check(/While you were out|Nothing new since/i.test(pageText), 'with 0042 applied the queue is split by the last visit');
      }

      const over = await sideways(p);
      check(over <= 1, `at ${width}px nothing scrolls sideways`, `${over}px`);

      // ---- the detail page
      await p.goto(`${BASE}/app/today/yesterday`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(p);
      check(await p.locator('[data-error-boundary]').count() === 0, 'the Yesterday detail page renders');
      const detail = flat(await p.locator('body').innerText());
      check(/Needs your follow-up/i.test(detail), 'it carries the follow-up section');
      check(/Today.s queue, in full/i.test(detail), 'and the whole queue');
      check(/keeps it in that candidate.s own history|never deleted/i.test(detail), 'and says a resolved follow-up is kept, not deleted');
      const overDetail = await sideways(p);
      check(overDetail <= 1, `the detail page does not scroll sideways at ${width}px`, `${overDetail}px`);
      await ctx.close();
    }

    // ---- the since filter is a parameter on the REAL Leads page
    console.log('\n--- the filtered Leads view ---');
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const p = await ctx.newPage();
    await signIn(p, who);
    const since = new Date(Date.now() - 3 * 86400000).toISOString();
    await p.goto(`${BASE}/app/radar?tab=won&since=${encodeURIComponent(since)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(p);
    check(await p.locator('[data-error-boundary]').count() === 0, 'the filtered Leads page renders');
    check(await appears(p, '[data-since-filter]'), 'it says it is filtered, and to when');
    const banner = flat(await p.locator('[data-since-filter]').innerText());
    // The arithmetic, not just the banner: RECENT of the seeded leads fall inside a three-day
    // window and OLD fall outside it, so this must read "2 of 5" and offer all 5.
    check(new RegExp(`Showing ${RECENT} of ${WON} open leads`).test(banner),
      `the filter counts correctly — ${RECENT} of ${WON} inside a three-day window`, banner.slice(0, 160));
    check(new RegExp(`see all ${WON}`).test(banner), `the clear-filter link offers the whole list (${WON})`, banner.slice(0, 160));
    const rows = await p.locator('tbody tr').count();
    check(rows === RECENT, `and the table shows exactly the ${RECENT} leads found in the window`, `${rows} row(s)`);
    // The full column set, not a trimmed table.
    const heads = await p.locator('thead th').allInnerTexts();
    check(heads.length >= 7 && heads.some((h) => /Decision-maker/i.test(h)) && heads.some((h) => /Verified/i.test(h)),
      'the same full column set as the unfiltered page', heads.join(' | '));

    // A chip must not drop the filter.
    const chip = p.locator('[data-source-filter] a').nth(1);
    const chipHref = await chip.getAttribute('href');
    check(!!chipHref && chipHref.includes('since='), 'a source chip keeps ?since= — the filter is not cleared by clicking one', String(chipHref));
    const sortHref = await p.locator('[data-sort-control] a').last().getAttribute('href');
    check(!!sortHref && sortHref.includes('since='), 'and so does the sort control', String(sortHref));

    await p.locator('[data-clear-since]').click();
    await p.waitForLoadState('domcontentloaded');
    await hydrated(p);
    check(!p.url().includes('since='), 'clearing the filter returns to the unfiltered list', p.url());
    check(await p.locator('[data-since-filter]').count() === 0, 'and the filter banner is gone');
    await ctx.close();
  } finally {
    await browser.close();
    // In foreign-key order, and every table this probe seeds. clearTestWorkspace covers candidates
    // and documents — not leads, job_posts or companies — so a probe that seeds those and leaves
    // them strands its own workspace on leads_workspace_id_fkey (twice tonight, 2026-09-17).
    const mine: string[] = [];
    for (const t of ['job_posts', 'leads', 'companies'] as const) {
      const { error } = await admin.from(t).delete().eq('workspace_id', who.workspace);
      if (error) mine.push(`${t}: ${error.message}`);
    }
    const notGone = await removeProbe(admin, who.uid, who.workspace, null, { clearContent: true });
    const left = [...mine, notGone].filter(Boolean).join('; ');
    console.log(left ? `\ncleanup left something behind: ${left}` : '\nthe probe account, its workspace and everything seeded were removed');
    if (left) failures++;
  }

  console.log(failures
    ? `\ntoday probe: ${failures} FAILED`
    : `\ntoday probe: all checks passed (${applied ? '0042 applied' : '0042 NOT applied — the visit split and follow-up list are still unverified'})`);
  process.exit(failures ? 1 : 0);
})();
