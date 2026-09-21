/**
 * Priority's window and its uncapped list (owner's decision, 2026-09-21).
 *
 *   npx tsx --env-file=.env.local scripts/priority-window-probe.ts http://localhost:3163
 *
 * Priority used to read "leads with status = new in the last 7 days", ranked, then folded into ONE
 * item naming six of them and five hiring-now companies. It now reads "everything since your last
 * visit", one row per lead, with no cap at all. Three things have to be true for that to mean
 * anything, and each is checked against a DECOY, because a window that filters nothing and a window
 * that filters everything both pass a test that only counts rows:
 *
 *   1. a lead that arrived just INSIDE the window is on screen;
 *   2. a lead that arrived just BEFORE it is NOT — two minutes on the other side of the boundary;
 *   3. thirteen qualifying leads all render, and the count on the heading equals the rows beneath it,
 *      so a silent truncation cannot hide behind a number computed before the slice.
 *
 * And two more that this item's findings demand:
 *
 *   4. THE STAMP ACTUALLY ADVANCES. The write lived in Today's page with the signed-in user's client
 *      and answered 42501 permission denied for table users on every load since 0042 — unread, so
 *      both real accounts still held NULL four days later. today-probe could not see it because it
 *      seeds last_seen_at with the SERVICE ROLE, which proves the display given a stamp and never
 *      that the app can write one. This drives the real route and then reads the row back.
 *   5. THE 24-HOUR VIEW IS UNTOUCHED. The decoy from check 2 — hidden from Priority for being before
 *      the visit boundary — must still appear under "Last 24 hours", because that window is rolling
 *      elapsed time and has nothing to do with visit history. If it went missing there, this item
 *      would have leaked into a code path it was explicitly told not to touch.
 *
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

/** Empty while the page rendered; otherwise WHAT threw, taken off the boundary itself. */
const boundaryWhy = async (p: Page) => {
  if (await p.locator('[data-error-boundary]').count() === 0) return '';
  const ref = flat(await p.locator('[data-error-reference]').first().innerText().catch(() => ''));
  const said = flat(await p.locator('[data-error-boundary]').first().innerText().catch(() => ''));
  return `error boundary on screen — ${ref || 'no reference shown'} — ${said.slice(0, 120)}`;
};

/** How many leads land inside the window. Named once: the next person to seed one would otherwise
 *  change the total and leave the "nothing is truncated" arithmetic asserting the old number. */
const INSIDE = 13;
/** Where the previous visit ended. Two hours back, so it is a real absence by visitWindow's 30-minute rule. */
const VISIT_MS = 2 * 3600 * 1000;

async function account() {
  const email = `priority-window+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: 'Priority Window Probe', agency: 'Priority Window Probe' } });
  if (error) throw new Error(`could not create the probe account: ${error.message}`);
  const uid = data.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  await markWorkspaceTest(admin, me?.workspace_id);
  // Read the problem rather than discarding it: an account that never followed an industry is sent to
  // /app/onboarding for the whole run, and every content check then fails for a reason nothing names.
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
  const landed = p.url().replace(BASE, '') || '/';
  if (!/^\/app(\/|$)/.test(landed) || /^\/app\/onboarding/.test(landed)) {
    throw new Error(`signing in did not reach the app — landed on ${landed}`);
  }
  // Signing in LANDS ON TODAY (onboarding_day 30), and Today advances the stamp. Let that write finish
  // before the caller seeds a boundary, or it lands afterwards and silently overwrites it: the first
  // run of this probe failed two checks that way — the decoy appeared because there was no window left
  // to exclude it, and the stamp reported "same" because it had already been advanced a second earlier.
  // The probe was wrong, not the page. Waiting on the element the component already publishes.
  await settled(p);
}

/** Resolves once VisitStamp has stopped saying "pending" — or at once where there is no stamp. */
const settled = (p: Page) => p.waitForFunction(
  () => {
    const el = document.querySelector('[data-visit-stamp]');
    return !el || el.getAttribute('data-visit-stamp') !== 'pending';
  },
  undefined,
  { timeout: 30000 },
).catch(() => {});

(async () => {
  const { error: noLastSeen } = await admin.from('users').select('last_seen_at').limit(1);
  if (noLastSeen) { console.log(`migration 0042 is NOT applied (${noLastSeen.message}) — there is no visit window to check`); process.exit(2); }

  // A previous run killed by Windows leaves the account behind whatever its own handlers did.
  const { data: old } = await admin.from('users').select('id, workspace_id').like('name', 'Priority Window Probe%');
  for (const u of old ?? []) {
    console.log('sweeping a leftover probe account');
    for (const t of ['job_posts', 'leads', 'companies'] as const) await admin.from(t).delete().eq('workspace_id', u.workspace_id);
    await removeProbe(admin, u.id, u.workspace_id, null, { clearContent: true });
  }

  const who = await account();
  const boundary = new Date(Date.now() - VISIT_MS);
  /** Put the boundary back exactly where the checks assume it is. The page ADVANCES it on every load
   *  (that is the point of check 4), so a later navigation would otherwise read a window this probe
   *  never set up, and the decoys would stop meaning anything. */
  const setVisit = () => admin.from('users').update({ last_seen_at: boundary.toISOString() }).eq('id', who.uid);

  const browser = await chromium.launch();
  let rows = 0;
  try {
    // Each lead gets its own company, because the row on screen is titled with the company's name and
    // "is this lead shown?" has to be answerable by looking for one string.
    const before = `PW${stamp} BeforeBoundary`;
    const inside = Array.from({ length: INSIDE }, (_, i) => `PW${stamp} Inside${String(i + 1).padStart(2, '0')}`);
    const { data: companies, error: cErr } = await admin.from('companies').insert(
      [before, ...inside].map((name) => ({ workspace_id: who.workspace, name, country: 'DK', employer_type: 'end_client', is_test: true })),
    ).select('id, name');
    if (cErr) throw new Error(`seeding companies failed: ${cErr.message}`);
    const idOf = new Map((companies ?? []).map((c: any) => [c.name, c.id]));

    // Two minutes the wrong side of the boundary, and the rest spread across the half hour after it.
    // Minutes rather than days on purpose: a boundary tested with a day of slack either side would
    // pass against a window that is out by hours.
    const at = (msAfterBoundary: number) => new Date(boundary.getTime() + msAfterBoundary).toISOString();
    const leadRows = [
      { name: before, created_at: at(-2 * 60 * 1000), fit: 99 },
      ...inside.map((name, i) => ({ name, created_at: at((i + 1) * 2 * 60 * 1000), fit: 90 - i })),
    ].map((r) => ({
      workspace_id: who.workspace, company_id: idOf.get(r.name), kind: 'won_work', status: 'new',
      country: 'DK', project_name: `Priority window ${r.name}`, trades_inferred: ['welder'],
      fit_score: r.fit, created_at: r.created_at, is_test: true,
    }));
    const { error: lErr } = await admin.from('leads').insert(leadRows);
    if (lErr) throw new Error(`seeding leads failed: ${lErr.message}`);
    // The decoy carries the HIGHEST fit of the set. A cap that kept "the best six" would keep it, so
    // check 2 fails loudly if the window is not really being applied rather than passing by luck.
    console.log(`seeded ${INSIDE} leads inside the window and 1 two minutes before it (fit 99, the highest of the set), boundary ${boundary.toISOString()}`);

    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const page = await ctx.newPage();
    await signIn(page, who);

    // ---- 1, 2, 3 — the window and the absence of a cap
    await setVisit();
    await page.goto(`${BASE}/app/today`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);
    const why = await boundaryWhy(page);
    check(!why, 'Today renders — no error boundary', why);
    if (why) throw new Error('the page did not render, so nothing below can be judged');

    const body = flat(await page.locator('body').innerText());
    check(body.includes(inside[0]), 'a lead two minutes INSIDE the window is on screen', inside[0]);
    check(!body.includes(before), 'a lead two minutes BEFORE the window is not', `${before} (fit 99 — the highest seeded)`);

    // Scoped to the queue's own container. [data-queue-item] ALSO matches the "while you were out"
    // teaser above it — a different, deliberately capped feature this item was told not to touch — so
    // counting them together made the heading's number disagree with the rows by exactly the teaser's
    // three. Counting the whole page was the probe's mistake, not a cap.
    rows = await page.locator('[data-queue-list] [data-queue-item]').count();
    const shown = inside.filter((n) => body.includes(n)).length;
    check(shown === INSIDE, `all ${INSIDE} qualifying leads render — nothing is truncated`, `${shown} of ${INSIDE} on screen, ${rows} queue row(s) in total`);
    // The heading's number is computed before the rows are drawn, so a cap between the two would show
    // as a count that disagrees with what is under it — the "Showing 3 of 5" fault, one step earlier.
    const badge = Number(await page.locator('[data-queue-count]').first().getAttribute('data-queue-count') ?? '-1');
    check(badge === rows, 'the count on the heading equals the rows beneath it', `heading says ${badge}, ${rows} row(s) rendered`);
    check(rows > 11, 'the list is longer than the old cap of 6 leads + 5 companies', `${rows} rows`);

    // Each row opens ITS OWN lead now, not a set — the combined item's multi-id href is gone.
    const hrefs = await page.locator('[data-queue-list] [data-queue-item]').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
    const won = hrefs.filter((h) => h.includes('tab=won&ids='));
    check(won.length > 0 && won.every((h) => (h.split('ids=')[1] ?? '').split('&')[0].split(',').length === 1),
      'each lead row links to exactly one lead id', won[0]?.slice(0, 80) ?? 'no won-work row');

    // The fault that took this card down at 390px (React #418).
    const nested = await page.evaluate(() => document.querySelectorAll('a a').length);
    check(nested === 0, 'no anchor sits inside another anchor', `${nested} nested`);
    check(await sideways(page) <= 0, 'nothing scrolls sideways at 1500px');

    // ---- 4 — the stamp advances, which is the thing that was broken
    await settled(page);
    const stampSaid = await page.locator('[data-visit-stamp]').first().getAttribute('data-visit-stamp').catch(() => null);
    check(stampSaid === 'advanced', 'the page reports the visit stamp was written', `settled "${stampSaid}"`);
    const { data: after } = await admin.from('users').select('last_seen_at').eq('id', who.uid).single();
    const moved = after?.last_seen_at ? Date.parse(after.last_seen_at) - boundary.getTime() : -1;
    check(moved > VISIT_MS / 2, 'users.last_seen_at really moved in the database', after?.last_seen_at ? `now ${after.last_seen_at}` : 'still NULL — the write did not land');

    // ---- 5 — "Last 24 hours" is untouched
    await setVisit();
    await page.goto(`${BASE}/app/today?view=24h`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);
    const feed = flat(await page.locator('body').innerText());
    const groups = await page.locator('[data-source-group]').count();
    check(groups === 3, 'the 24-hour view still renders its three source groups', `${groups} group(s)`);
    // The decisive one: the lead Priority hides for being before the visit boundary is inside a rolling
    // 24 hours, so it must still be here. Visit history must not have reached this window at all.
    check(feed.includes(before), 'the lead Priority hides is still in the 24-hour view — that window is elapsed time, not visit history', before);
    check(feed.includes(inside[0]), 'and so are the leads Priority shows', inside[0]);

    // ---- 390px, because the queue is a scrolling container now
    //
    // setVisit AFTER signing in, never before: signing in lands on Today and advances the stamp, so a
    // boundary seeded first is overwritten before the page under test ever reads it. The first run
    // showed 14 rows here against 16 — not a width problem at all, but this window never being applied.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const small = await phone.newPage();
    await signIn(small, who);
    await setVisit();
    await small.goto(`${BASE}/app/today`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(small);
    const whyPhone = await boundaryWhy(small);
    check(!whyPhone, 'Today renders at 390px — no error boundary', whyPhone);
    if (!whyPhone) {
      const smallRows = await small.locator('[data-queue-list] [data-queue-item]').count();
      check(smallRows === rows, 'the phone shows the same number of rows — the list is not trimmed for width', `${smallRows} at 390px against ${rows} at 1500px`);
      check(await sideways(small) <= 0, 'nothing scrolls sideways at 390px');
      const nestedPhone = await small.evaluate(() => document.querySelectorAll('a a').length);
      check(nestedPhone === 0, 'no nested anchor at 390px', `${nestedPhone} nested`);
    }
    await phone.close();
  } finally {
    await browser.close();
    // clearTestWorkspace covers candidates and documents, NOT the leads and companies seeded here, and
    // companies_workspace_id_fkey then blocks the workspace delete and strands it — which is exactly
    // what the first run of this probe did. Removed in foreign-key order, before removeProbe.
    const mine: string[] = [];
    for (const t of ['job_posts', 'leads', 'companies'] as const) {
      const { error } = await admin.from(t).delete().eq('workspace_id', who?.workspace);
      if (error) mine.push(`${t}: ${error.message}`);
    }
    const notGone = await removeProbe(admin, who?.uid, who?.workspace, null, { clearContent: true });
    const left = [...mine, notGone].filter(Boolean).join('; ');
    if (left) { console.log(`LEFTOVER: ${left}`); failures++; }
  }

  console.log(failures ? `\npriority window: ${failures} FAILED` : '\npriority window: all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
