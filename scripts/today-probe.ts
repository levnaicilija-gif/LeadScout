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
/**
 * Empty while the page rendered; otherwise WHAT threw, taken off the boundary itself (2026-09-18).
 *
 * The check used to count [data-error-boundary] and say only that one was there, so a failed render
 * reported "no error boundary — FAIL" and nothing else: on 2026-09-18 the 390px run failed this way and
 * the cause had to be recovered from next start's own log afterwards, where it read
 * "AuthRetryableFetchError 0", digests 273046742 and 1786437619 — the transient already on file. error.tsx
 * prints that digest as "Reference: <digest>" (data-error-reference), which is the one piece of evidence
 * tying a probe failure to a server error, and the probe was throwing it away.
 */
const boundaryWhy = async (p: Page) => {
  if (await p.locator('[data-error-boundary]').count() === 0) return '';
  const ref = flat(await p.locator('[data-error-reference]').first().innerText().catch(() => ''));
  const said = flat(await p.locator('[data-error-boundary]').first().innerText().catch(() => ''));
  return `error boundary on screen — ${ref || 'no reference shown'} — ${said.slice(0, 120)}`;
};
/**
 * Why the follow-up list does not hold the row it was asked for (2026-09-19). Same fault as boundaryWhy
 * above: the page already says what went wrong and the check was throwing it away.
 *
 * `followups()` degrades softly — a failed `outreach` read pushes its message into `state.error` and
 * returns `active` WITHOUT the row (src/lib/followups.ts:66), so the page renders "Nothing waiting on
 * you" (data-no-followups) under "Some follow-ups could not be read: <message>". Both are on screen and
 * this check read neither, so a transient read failure and a genuinely missing row failed identically:
 * "the unanswered outreach is listed as a follow-up — FAIL" and nothing else, twice on 2026-09-19
 * (00:14 and 09:39), neither attributable without re-running by hand. The data itself was proved sound
 * both times — service role and the RLS-bound user each return the row, and the page renders it.
 */
const followupWhy = async (p: Page) => {
  const read = flat(await p.locator('body').innerText().catch(() => '')).match(/Some follow-ups could not be read:[^.]*/i);
  if (read) return read[0];
  if (await p.locator('[data-no-followups]').count() > 0) return 'the list rendered empty — "Nothing waiting on you", and the page reported no read error';
  if (await p.locator('[data-followup-list]').count() === 0) return 'no follow-up list rendered at all — the section never got that far';
  const keys = await p.locator('[data-followup]').evaluateAll((els) => els.map((e) => e.getAttribute('data-followup')));
  return `the list rendered, carrying ${keys.length} other row(s): ${JSON.stringify(keys).slice(0, 120)}`;
};

async function account() {
  const email = `today-probe+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: 'Today Probe', agency: 'Today Probe' } });
  if (error) throw new Error(`could not create the probe account: ${error.message}`);
  const uid = data.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  await markWorkspaceTest(admin, me?.workspace_id);
  // READ the problem rather than discarding it (2026-09-18). followAllForProbe RETURNS a string and never
  // throws — deliberately, so the caller decides what a failure means — and this called it bare, the way
  // design-shots does not (design-shots.ts:44-45 throws). An account whose industry_follow write failed
  // has not chosen industries, so (rail)/layout.tsx:23 sends it to /app/onboarding for the whole run, and
  // every content check then fails with [] and -1 while "renders — no error boundary" and "no nested
  // anchor" still PASS, because an empty page satisfies an absence check. Nothing in the output said so.
  const followProblem = await followAllForProbe(admin, uid);
  if (followProblem) throw new Error(followProblem);
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
  // Say WHERE it landed, and refuse to carry on somewhere else (2026-09-18). The wait above matches
  // /app/onboarding exactly as well as /app/today and swallows its own timeout besides, so a run could
  // proceed from the onboarding gate — or from /login after a failed auth check — with every later
  // assertion failing for a reason no line of the output named. A run that cannot reach the app must stop
  // here, where the URL is still in hand, rather than 30 seconds later at a locator that was never coming.
  const landed = p.url().replace(BASE, '') || '/';
  if (!/^\/app(\/|$)/.test(landed) || /^\/app\/onboarding/.test(landed)) {
    throw new Error(`signing in did not reach the app — landed on ${landed}${/onboarding/.test(landed) ? ' (the industry gate: this account never followed any industry)' : ''}`);
  }
}

(async () => {
  // Which path can honestly be checked?
  const { error: noLastSeen } = await admin.from('users').select('last_seen_at').limit(1);
  const { error: noFollowups } = await admin.from('followup_resolutions').select('id').limit(1);
  const applied = !noLastSeen && !noFollowups;
  // 0043 splits the visit stamp in two, which changes what the queue's heading can honestly say: with
  // it the boundary survives a reload and the heading names it, without it the page falls back to the
  // full queue. The assertion below branches on this rather than accepting either wording.
  const { error: noPrevVisit } = await admin.from('users').select('previous_visit_at').limit(1);
  const twoStamps = !noPrevVisit;
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
  // One lead an hour old, for the "last 24 hours" view (2026-09-18). Declared HERE rather than beside the
  // seed rows because WON is computed from it and const is not hoisted — the same ordering fault as the
  // `since` parse on the Leads page. RECENT is seeded at iso(1), exactly one day back, which sits ON the
  // 24-hour boundary and falls in or out on sub-second drift; the 24h assertions therefore count this
  // lead and never the boundary ones, or they would fail by the clock rather than by the code.
  const IN_WINDOW_LEADS = 1;
  const WON = OLD + RECENT + IN_WINDOW_LEADS;
  // How many fall inside the THREE-DAY ?since= window the filtered-Leads checks use: the recent two and
  // the hour-old one. Named once, because the next person to seed a lead will otherwise update the total
  // and miss these — which is exactly what adding IN_WINDOW_LEADS did to "Showing 2 of 5".
  const IN_SINCE_WINDOW = RECENT + IN_WINDOW_LEADS;
  const POSTS = 4;
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString();
  const company = (await admin.from('companies').insert({
    workspace_id: who.workspace, name: `Today Probe Yard ${stamp}`, country: 'DK', employer_type: 'end_client', is_test: true,
  }).select('id').single()).data!.id;

  const leadRows = [
    ...Array.from({ length: OLD }, (_, i) => ({ days: 5, n: i })),
    ...Array.from({ length: RECENT }, (_, i) => ({ days: 1, n: OLD + i })),
    ...Array.from({ length: IN_WINDOW_LEADS }, (_, i) => ({ days: 1 / 24, n: OLD + RECENT + i })),
  ].map(({ days, n }) => ({
    workspace_id: who.workspace, company_id: company, kind: 'won_work',
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
      // Staggered for the "last 24 hours" view (2026-09-18): the first posting was discovered an hour
      // ago, the rest two days ago. Every one used to be iso(2) — all outside a 24-hour window — so an
      // assertion on that view would have matched nothing and passed by filtering everything away, the
      // same vacuity already fixed in queue-ids-probe. posted_at stays two days old on ALL of them on
      // purpose: the window reads first_seen_at ("we discovered it") while the row DISPLAYS posted_at,
      // and seeding both alike would let a filter reading the wrong column pass anyway.
      posted_at: iso(2).slice(0, 10),
      first_seen_at: i === 0 ? iso(1 / 24) : iso(2),
      is_test: true,
    })),
  );
  if (postErr) throw new Error(`seeding postings failed: ${postErr.message}`);

  const won = WON;
  const openPosts = POSTS;
  console.log(`seeded in the probe's own workspace: ${WON} won-work leads (${OLD} older than the three-day window, ${RECENT} on the one-day boundary, ${IN_WINDOW_LEADS} an hour old), ${POSTS} open postings (1 discovered an hour ago, ${POSTS - 1} two days ago)`);

  // ---- the applied path, which the guarded run could not reach
  //
  // A last visit two days back, so "while you were out" has a real boundary and the two recent
  // leads fall inside it. And one outreach sent five days ago with no reply, because the real
  // workspace genuinely has no follow-ups — 0 unclear answers, 0 unanswered outreach — so Mark done
  // cannot be exercised without seeding one.
  const lastVisit = iso(2);
  let seededOutreach: string | null = null;
  if (applied) {
    const { error: seenErr } = await admin.from('users').update({ last_seen_at: lastVisit }).eq('id', who.uid);
    if (seenErr) throw new Error(`seeding the last visit failed: ${seenErr.message}`);
    const { data: lead } = await admin.from('leads').select('id').eq('workspace_id', who.workspace).limit(1).single();
    // 0046: outreach carries its own workspace_id and it is NOT NULL. Seeding without one used to
    // work because the row's scope was inherited from its lead; it now refuses, which is the point.
    const { data: o, error: oErr } = await admin.from('outreach').insert({
      workspace_id: who.workspace,
      lead_id: lead!.id, channel: 'email', subject: 'Probe outreach', body: 'Seeded so Mark done can be tested.',
      sent_by: who.uid, sent_at: iso(5), status: 'sent',
    }).select('id').single();
    if (oErr) throw new Error(`seeding the outreach failed: ${oErr.message}`);
    seededOutreach = o!.id;
    console.log(`seeded the applied path: last visit ${lastVisit.slice(0, 16)}, one outreach sent 5 days ago with no reply`);
  }
  const browser = await chromium.launch();
  try {
    for (const width of [1500, 390] as const) {
      console.log(`\n--- ${width}px ---`);
      const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, hasTouch: width === 390, isMobile: width === 390 });
      const p = await ctx.newPage();
      await signIn(p, who);

      await p.goto(`${BASE}/app/today`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(p);
      const todayWhy = await boundaryWhy(p);
      check(todayWhy === '', 'Today renders — no error boundary', todayWhy);

      // ---- the view toggle (2026-09-18)
      //
      // The nesting check is the point of this block, not a formality: making queue rows links put an <a>
      // inside the card's own <a> and took Today down at 390px with React #418, whose minified message says
      // only a number. The toggle sits as a sibling of the heading inside a div for that reason, and this
      // asserts it stays that way. Both URLs are loaded because the active state must FOLLOW the parameter —
      // checking only the default would pass just as well if the toggle ignored the URL entirely.
      check(await p.evaluate(() => document.querySelectorAll('a a').length) === 0,
        'no anchor is nested inside another anchor', `${await p.evaluate(() => document.querySelectorAll('a a').length)} found`);
      check(await p.locator('[data-today-view]').count() === 2, 'both view buttons render — Priority and Last 24 hours');
      const activeOn = async () => p.evaluate(() => [...document.querySelectorAll('[data-today-view]')]
        .filter((e) => (e as HTMLElement).dataset.active === 'true').map((e) => (e as HTMLElement).dataset.todayView));
      const bare = await activeOn();
      check(bare.length === 1 && bare[0] === 'priority', 'with no parameter, Priority is the one marked active — the default is the absence of it', JSON.stringify(bare));
      const viewHrefs = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-today-view]')]
        .map((e) => [(e as HTMLElement).dataset.todayView, e.getAttribute('href')])));
      check(viewHrefs.priority === '/app/today' && viewHrefs['24h'] === '/app/today?view=24h',
        'and each button points where it should — Priority back to the bare URL, not ?view=priority', JSON.stringify(viewHrefs));
      await p.goto(`${BASE}/app/today?view=24h`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(p);
      const on24h = await activeOn();
      check(on24h.length === 1 && on24h[0] === '24h', 'and ?view=24h moves the active mark onto it', JSON.stringify(on24h));
      check(await p.evaluate(() => document.querySelectorAll('a a').length) === 0, 'still no nested anchor on the 24h view');
      const view24hWhy = await boundaryWhy(p);
      check(view24hWhy === '', 'and the 24h view renders — no error boundary', view24hWhy);

      // ---- the last 24 hours, counted exactly (2026-09-18)
      //
      // Exact numbers from the seed constants, never a threshold: a check reading `rows > 0` passes on the
      // right rows and the wrong ones alike, which is how a filter that returns everything looks healthy.
      const groups = await p.evaluate(() => [...document.querySelectorAll('[data-source-group]')]
        .map((e) => [(e as HTMLElement).dataset.sourceGroup, Number((e.querySelector('[data-group-count]') as HTMLElement)?.dataset.groupCount ?? -1)]));
      check(groups.length === 3 && groups.map(([k]) => k).join(',') === 'news,ted,hiring',
        'all three sources have a section, in a fixed order', JSON.stringify(groups));
      const countOf = (k: string) => (groups.find(([g]) => g === k)?.[1] ?? -1) as number;
      // Four postings, ONE company: this view lists companies to call, not adverts, so grouping is what is
      // being asserted here — a per-advert list would read 1 and look identical to a broken 4.
      check(countOf('hiring') === 1, 'hiring groups four adverts into the one company behind them', `${countOf('hiring')}`);
      // Every seeded lead is example.invalid, so leadSource() calls them all news and TED is legitimately
      // empty — the one case in this seed that proves a silent source still announces itself.
      check(countOf('ted') === 0, 'TED is empty in this workspace', `${countOf('ted')}`);
      const tedText = flat(await p.locator('[data-source-group="ted"]').innerText().catch(() => ''));
      check(/no award notices in the last 24 hours/i.test(tedText),
        'and says so rather than vanishing — a quiet source is information', tedText.slice(0, 110));
      check(countOf('news') === IN_WINDOW_LEADS, `news holds the ${IN_WINDOW_LEADS} lead created inside the window`, `${countOf('news')}`);
      const rowsIn24h = await p.locator('[data-last24-row]').count();
      // Summed from the group counts rather than a constant plus a bare 1: the "+1" was the hiring group,
      // an unnamed number of exactly the kind that drifts when a seed changes — the same fault the
      // IN_SINCE_WINDOW rename had just removed from this file. This also makes the check mean something
      // sharper: the rendered rows must equal what the three headings claim, so a group that counts five
      // and lists four cannot pass.
      const claimed = countOf('news') + countOf('ted') + countOf('hiring');
      check(rowsIn24h === claimed, 'the rows on screen match what the group headings claim', `${rowsIn24h} row(s) vs ${claimed} claimed`);
      // A row states the date the thing HAPPENED — and for a great many real leads there is no such
      // date to state: 644 of 1008 articles carry published_at (counted 2026-09-18), so a third of them
      // say when nothing. Demanding a date of EVERY row asserts something untrue of production, and the
      // only way to satisfy it in the page would be to show created_at — when WE found it — as if it
      // were when it happened, which is the one thing last24h's contract forbids. The first form of this
      // check did demand exactly that and failed here; the page was right and the assertion was wrong.
      // So the two cases are checked apart, by group, against what this seed actually creates:
      //
      //   hiring — always dated, because posted_at falls back to first_seen_at and the crawl always
      //            knows when it first saw an advert;
      //   news   — the seeded lead has NO article, so its date is honestly absent. An article is not
      //            seeded to make it dated: articles are global (no workspace_id, no is_test) and
      //            lead_articles.article_id does not cascade, so one seeded here could not be swept by
      //            workspace and would sit in the real table indistinguishable from crawled content.
      //
      // The empty attribute is still refused: the undated row must SAY "no date on the source" beside
      // its basis, which is what stops a row that renders nothing at all from passing as honest.
      const datesIn = (group: string) => p.evaluate((g) => [...document.querySelectorAll(`[data-source-group="${g}"] [data-last24-row] [data-row-ts]`)]
        .map((e) => ({ ts: (e as HTMLElement).dataset.rowTs ?? '', text: (e.textContent ?? '').replace(/\s+/g, ' ').trim() })), group);
      const hiringDates = await datesIn('hiring');
      check(hiringDates.length === countOf('hiring') && hiringDates.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.ts)),
        'every hiring row carries a real date — the crawl always knows when it first saw an advert',
        JSON.stringify(hiringDates.map((r) => r.ts)));
      const newsDates = await datesIn('news');
      check(newsDates.length === countOf('news') && newsDates.every((r) => r.ts === '' && /no date on the source/i.test(r.text)),
        'the seeded news lead has no article, so its row says "no date on the source" rather than going blank',
        JSON.stringify(newsDates));
      // The hiring row must point at the HIRING tab: its id is a company id, and sending it to Won work
      // would filter lead ids against it and match nothing. Checked by group, never by position.
      const hiringHref = await p.locator('[data-source-group="hiring"] [data-last24-row]').first().getAttribute('href').catch(() => null);
      check(/\/app\/radar\?tab=hiring&ids=/.test(hiringHref ?? ''), 'the hiring row opens the hiring tab, filtered to its company', String(hiringHref).slice(0, 90));
      const newsHref = await p.locator('[data-source-group="news"] [data-last24-row]').first().getAttribute('href').catch(() => null);
      check(/\/app\/radar\?tab=won&ids=/.test(newsHref ?? ''), 'and the news row opens Won work, filtered to its leads', String(newsHref).slice(0, 90));

      await p.goto(`${BASE}/app/today`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(p);

      // ---- the three top cards
      check(await appears(p, '[data-today-card]'), 'the Today card is there');
      check(await appears(p, '[data-yesterday-card]'), 'the Yesterday card is there');
      check(await appears(p, '[data-leads-card]'), 'the Leads card is there');

      // The card is a div and its heading carries the link (2026-09-17): each queue row inside it is a
      // link of its own now, and an <a> inside an <a> is invalid — the parser closes the outer one and
      // hydration fails. data-today-card still marks the card, so the text assertions below are unchanged;
      // the href moved to the heading, which is what data-today-link marks.
      const todayHref = await p.locator('[data-today-link]').getAttribute('href');
      check(!!todayHref && todayHref.startsWith('/app/radar'), 'the Today card opens the real Leads page', String(todayHref));
      if (applied) check(!!todayHref && todayHref.includes('since='), 'carrying ?since= — the recruiter\'s own last visit', String(todayHref));
      check(await p.locator('[data-yesterday-card]').getAttribute('href') === '/app/today/yesterday', 'the Yesterday card opens the detail page');
      check(await p.locator('[data-leads-card]').getAttribute('href') === '/app/radar', 'the Leads card opens Leads, unfiltered');

      // ---- the four tool cards, each onto a page that exists
      const tools = await p.locator('[data-tool-card]').count();
      check(tools === 4, 'four tool cards', `${tools}`);
      // The cand card is Certificate check and opens /app/certificate, not Verify (027e1c5 moved it when that
      // screen became its own page). This line still said /app/verify and nothing caught it for a day, because
      // this probe was not a gate step until 2026-09-18 — the first run after registering it failed here, which
      // is the probe doing its job rather than a fault in the page. `leads` is the "Drop a CV" card and still
      // goes to Verify, so only the first pair moved.
      for (const [tone, href] of [['cand', '/app/certificate'], ['leads', '/app/verify'], ['pitch', '/app/pitch']] as const) {
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
        // A real boundary was seeded two days back, so the header must be THERE — accepting
        // "or nothing new since" would pass either way and prove nothing.
        check(/While you were out/i.test(pageText), 'with 0042 applied the queue is split by the last visit');
        check(/you were last here/i.test(pageText), 'and the page says when that was', flat(pageText).slice(0, 120));
        // Case-insensitive on purpose: the window labels carry `uppercase tracking-wide`, so the
        // rendered text is "WHILE YOU WERE OUT 1" and a case-sensitive pattern cannot match it
        // (2026-09-17). Still requires the count and the clock — loosened for case, not for content.
        const outCount = flat(await p.locator('[data-today-card]').innerText());
        check(/while you were out\s+\d/i.test(outCount), 'the out window carries a count', outCount.slice(0, 90));
        // WHAT THIS USED TO CHECK, AND WHY IT WAS WRONG (2026-09-21). It was `/since\s+\d\d:\d\d/i`
        // for "the live window counts from when they arrived" — a heading that no longer exists:
        // Priority's queue now names the window it actually filtered on ("Since your last visit ·
        // HH:MM", or "The queue" when there is no honest boundary). Worse, it had been passing for the
        // wrong reason. With 0042 alone the stamp advanced on the probe's own sign-in load, so by the
        // assertion load `since` had collapsed to the arrival, the out window was EMPTY, and the
        // string it matched was the empty state — "Nothing new since 09:23". A check that only matches
        // when the feature finds nothing is the shape this repo keeps meeting; 0043 filling the out
        // window with its three real rows is what finally exposed it.
        if (twoStamps) {
          // The boundary was seeded two days back and 0043 keeps it across the reload, so the heading
          // must name it. Requiring the clock too, so a bare label cannot satisfy this.
          check(/since your last visit\s*·\s*\d\d:\d\d/i.test(outCount),
            'and the queue names the boundary it filtered on, which survives the reload (0043)', outCount.slice(0, 200));
        } else {
          // Without the second column the boundary is consumed by the first load, so the queue widens
          // to the full list and says so. It must NOT claim a window it no longer has.
          check(/the queue/i.test(outCount) && !/since your last visit/i.test(outCount),
            'and without 0043 the queue falls back to the full list rather than claiming a shrunken window', outCount.slice(0, 200));
        }
        check(await p.locator('[data-live-refresh]').count() === 1, 'the live window says it is checking while they are here');
      }

      const over = await sideways(p);
      check(over <= 1, `at ${width}px nothing scrolls sideways`, `${over}px`);

      // ---- the detail page
      await p.goto(`${BASE}/app/today/yesterday`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(p);
      const yesterdayWhy = await boundaryWhy(p);
      check(yesterdayWhy === '', 'the Yesterday detail page renders', yesterdayWhy);
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
    const filteredWhy = await boundaryWhy(p);
    check(filteredWhy === '', 'the filtered Leads page renders', filteredWhy);
    const filtered = await appears(p, '[data-since-filter]');
    check(filtered, 'it says it is filtered, and to when', filtered ? '' : filteredWhy || 'no [data-since-filter] on the page');
    // Everything below reads that banner or clicks the link inside it, so with no banner there is nothing
    // to read: on 2026-09-19 the auth transient put an error boundary on this page and the next line spent
    // 30 s in innerText and killed the run — with the boundary's own reference already printed one line
    // above, and the follow-up round trip never reached. Same guard as that round trip's, one section up.
    if (!filtered) {
      check(false, 'the filtered Leads checks could not run', 'the page never showed its filter banner — the two lines above say why');
    } else {
      const banner = flat(await p.locator('[data-since-filter]').innerText());
      // The arithmetic, not just the banner: IN_SINCE_WINDOW of the seeded leads fall inside a three-day
      // window and OLD fall outside it. Counted from the constants — when the 24h view added an hour-old
      // lead this read "2 of 5" against a page rendering "3 of 6", which a hardcoded literal would have
      // turned into a mystery instead of an arithmetic change.
      check(new RegExp(`Showing ${IN_SINCE_WINDOW} of ${WON} open leads`).test(banner),
        `the filter counts correctly — ${IN_SINCE_WINDOW} of ${WON} inside a three-day window`, banner.slice(0, 160));
      check(new RegExp(`see all ${WON}`).test(banner), `the clear-filter link offers the whole list (${WON})`, banner.slice(0, 160));
      const rows = await p.locator('tbody tr').count();
      check(rows === IN_SINCE_WINDOW, `and the table shows exactly the ${IN_SINCE_WINDOW} leads found in the window`, `${rows} row(s)`);
      // The full column set, not a trimmed table.
      const heads = await p.locator('thead th').allInnerTexts();
      check(heads.length >= 7 && heads.some((h) => /Decision-maker/i.test(h)) && heads.some((h) => /Verified/i.test(h)),
        'the same full column set as the unfiltered page', heads.join(' | '));

      // A chip must not drop the filter.
      const chip = p.locator('[data-source-filter] a').nth(1);
      const chipHref = await chip.getAttribute('href').catch(() => null);
      check(!!chipHref && chipHref.includes('since='), 'a source chip keeps ?since= — the filter is not cleared by clicking one', String(chipHref));
      const sortHref = await p.locator('[data-sort-control] a').last().getAttribute('href').catch(() => null);
      check(!!sortHref && sortHref.includes('since='), 'and so does the sort control', String(sortHref));

      await p.locator('[data-clear-since]').click();
      await p.waitForLoadState('domcontentloaded');
      await hydrated(p);
      check(!p.url().includes('since='), 'clearing the filter returns to the unfiltered list', p.url());
      check(await p.locator('[data-since-filter]').count() === 0, 'and the filter banner is gone');
    }
    await ctx.close();

    // ---- marking a follow-up done, and it staying on the record
    if (applied && seededOutreach) {
      console.log('\n--- the follow-up round trip ---');
      const fc = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
      const fp = await fc.newPage();
      await signIn(fp, who);
      await fp.goto(`${BASE}/app/today/yesterday`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(fp);

      const key = `no_reply:${seededOutreach}`;
      const listed = await appears(fp, `[data-followup="${key}"]`);
      check(listed, 'the unanswered outreach is listed as a follow-up', listed ? '' : await followupWhy(fp));
      // Read the row only if it is THERE. This line used to run regardless, so an absent row spent 30 s
      // in innerText and then killed the probe with an uncaught TimeoutError — the check above had already
      // recorded the failure, and the crash cost every remaining round-trip check as well as the run's own
      // summary line. A failed assertion must fail its own check and let the rest of the run report.
      const before = listed ? flat(await fp.locator(`[data-followup="${key}"]`).innerText()) : '';
      check(listed && /no response, 5 days/.test(before), 'and says how long it has been waiting',
        listed ? before.slice(0, 120) : 'not listed — see the line above');

      // Everything below DRIVES that row — fills its note, clicks its Mark done, then reads the Resolved
      // panel it moves into — so with no row there is nothing to drive. Each of those was an unguarded
      // locator call: guarding only the innerText above just moved the crash to the fill, which is what
      // a mutated run showed (TimeoutError at the fill, 30 s, run dead, remaining checks and the summary
      // line lost). Skip the round trip instead, and let the run finish and report everything else.
      if (!listed) {
        check(false, 'the follow-up round trip could not run', 'the row was never listed — the two lines above say why');
      } else {
        await fp.locator(`[data-followup-note="${key}"]`).fill('Rang them, calling back Thursday.');
        // Wait for the POST to answer and then for the item to GO, rather than sleeping and counting:
        // FollowupList calls router.refresh() after the write, and a flat wait passed once and raced
        // the next run (2026-09-17). A check that turns on timing is worse than no check (CLAUDE.md).
        const saved = fp.waitForResponse((r) => r.url().includes('/api/followup') && r.request().method() === 'POST', { timeout: 30000 });
        await fp.locator(`[data-mark-done="${key}"]`).click();
        const savedRes = await saved.catch(() => null);
        check(!!savedRes && savedRes.status() === 200, 'the resolution is saved (POST /api/followup answers 200)',
          savedRes ? String(savedRes.status()) : 'no response in 30 s');

        const gone = await fp.locator(`[data-followup="${key}"]`).waitFor({ state: 'detached', timeout: 30000 }).then(() => true).catch(() => false);
        check(gone, 'marking it done takes it out of the active list',
          gone ? '' : `still on screen after the refresh — ${flat(await fp.locator('[data-followup-list]').innerText().catch(() => ''))}`.slice(0, 160));
        check(await appears(fp, '[data-resolved-panel]'), 'and it appears under Resolved — never deleted, never hidden');
        const resolved = flat(await fp.locator('[data-resolved-panel]').innerText().catch(() => ''));
        check(/Rang them, calling back Thursday/.test(resolved), 'with what the recruiter said they did', resolved.slice(0, 160));
        check(/never deleted/i.test(resolved), 'and the panel says it is kept');

        const { data: row } = await admin.from('followup_resolutions')
          .select('kind, source_id, note, resolved_by, resolved_at').eq('source_id', seededOutreach).maybeSingle();
        check(row?.kind === 'no_reply' && row?.resolved_by === who.uid && !!row?.resolved_at,
          'the database holds who resolved it and when — the audit shape, not a deletion', JSON.stringify(row));
        check(row?.note === 'Rang them, calling back Thursday.', 'and the note they wrote');

        // Resolving twice is the same act, not two (0042's unique key).
        await fp.reload({ waitUntil: 'domcontentloaded' });
        await hydrated(fp);
        const { count: twice } = await admin.from('followup_resolutions')
          .select('id', { count: 'exact', head: true }).eq('source_id', seededOutreach);
        check(twice === 1, 'and exactly one resolution row exists for it', `${twice}`);
      }
      await fc.close();
    }
  } finally {
    await browser.close();
    // In foreign-key order, and every table this probe seeds. clearTestWorkspace covers candidates
    // and documents — not leads, job_posts or companies — so a probe that seeds those and leaves
    // them strands its own workspace on leads_workspace_id_fkey (twice tonight, 2026-09-17).
    const mine: string[] = [];
    // In foreign-key order, and every table this probe touches. outreach has NO workspace_id — it
    // hangs off lead_id — so it is cleared by the seeded leads and must go BEFORE them, or the lead
    // delete fails on its foreign key and strands the workspace (the fourth such omission tonight).
    // followup_resolutions is created by Mark done, not by the seed, and clearTestWorkspace covers
    // neither it nor outreach.
    const { error: resErr } = await admin.from('followup_resolutions').delete().eq('workspace_id', who.workspace);
    if (resErr && !/schema cache|does not exist/i.test(resErr.message)) mine.push(`followup_resolutions: ${resErr.message}`);
    const { data: seededLeads } = await admin.from('leads').select('id').eq('workspace_id', who.workspace);
    const leadIds = (seededLeads ?? []).map((l: any) => l.id);
    if (leadIds.length) {
      const { error } = await admin.from('outreach').delete().in('lead_id', leadIds);
      if (error) mine.push(`outreach: ${error.message}`);
    }
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
