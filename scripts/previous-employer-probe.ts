/**
 * Item 11 part 1 on screen: the "worked for this employer before" badge on a lead's score card.
 *
 * Seeds its own throwaway workspace, because the real pool cannot show this: the one usable CV on
 * file names Vard Brăila, Saver Saldature, Suduri Vest and Esbjerg Shipyard, and not one of them is
 * a company behind an open lead — so a run against real data would show no badge and prove nothing.
 *
 * Checks, at 1500px and again at 390px on a touch screen:
 *   1. the badge is on the card and READABLE — a class that exists is not a class that shows, and
 *      .btn-danger was defined, typechecked and invisible on 2026-09-16;
 *   2. it speaks about the EMPLOYER, never the site, and carries the years as the CV prints them;
 *   3. only the candidate who shares an employer is badged — the control candidate is not;
 *   4. the screening questions include the one this case earns, naming the employer.
 * Everything it makes is removed afterwards; a leftover fails the run.
 *
 *   npx tsx --env-file=.env.local scripts/previous-employer-probe.ts http://localhost:3163
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
const must = (r: { data: any; error: any }, what: string): any => { if (r.error || r.data == null) throw new Error(`seeding ${what} failed: ${r.error?.message ?? 'no row'}`); return r.data; };
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const hydrated = (p: Page) => p.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', undefined, { timeout: 60000 }).catch(() => {});
const sideways = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const code = (n: string) => `PREVEMP${String(stamp).slice(-4).replace(/\d/g, (d) => 'ABCDEFGHIJ'[Number(d)])}-P-${n}`;

/** Legible: it has text, its colour differs from what is behind it, and it occupies real space. */
const readable = async (p: Page, selector: string) => p.evaluate((sel) => {
  const el = document.querySelector(sel) as HTMLElement | null;
  if (!el) return { found: false, text: '', colour: '', behind: '', legible: false };
  const style = getComputedStyle(el);
  const colour = style.color;
  let behind = style.backgroundColor;
  let up: HTMLElement | null = el;
  while (up && (behind === 'rgba(0, 0, 0, 0)' || behind === 'transparent')) { up = up.parentElement; behind = up ? getComputedStyle(up).backgroundColor : 'rgb(255, 255, 255)'; }
  const text = (el.textContent ?? '').trim();
  const box = el.getBoundingClientRect();
  return { found: true, text, colour, behind, legible: text.length > 0 && colour !== behind && box.width > 0 && box.height > 0 };
}, selector);

async function account(label: string) {
  const email = `previous-employer-probe-${label}+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: `Previous Employer Probe ${label}`, agency: 'Previous Employer Probe' } });
  if (error) throw new Error(`could not create the ${label}: ${error.message}`);
  const uid = data.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  await markWorkspaceTest(admin, me?.workspace_id);
  // Without this the probe lands on /app/onboarding and never reaches the drawer.
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
  const senior = await account('senior');
  const W = senior.ownWorkspace;
  await admin.from('users').update({ role: 'senior', onboarding_day: 30 }).eq('id', senior.uid);

  const browser = await chromium.launch();
  try {
    // A company spelled as a company row spells it, and a CV spelled as a Romanian CV does.
    const company = must(await admin.from('companies').insert({
      workspace_id: W, name: 'VARD Braila', country: 'RO', is_test: true,
    }).select('id').single(), 'company').id as string;

    const lead = must(await admin.from('leads').insert({
      // lead_status is ('new','pursue','contacted','replied','call','trial','framework','not_for_us','stale') — no 'open'.
      workspace_id: W, company_id: company, kind: 'won_work', status: 'new',
      project_name: 'Probe hull section', country: 'RO', trades_inferred: ['plate worker'],
      job_description: 'Plate workers and fitters for hull sections in Brăila. ISO 9606 an advantage.',
      jd_version: 1, is_test: true,
    }).select('id').single(), 'lead').id as string;

    const base = { trade: 'Plate worker', trade_code: 'F', skills: ['plate fitting'], languages: ['Romanian'], certificates_claimed: [], pii: {} };
    const MATCH = code('8801');
    const CONTROL = code('8802');
    must(await admin.from('candidates').insert([
      {
        workspace_id: W, reference_code: MATCH, trade_code: 'F', full_name: 'Probe Employer Person', trade: 'Plate worker',
        created_via: 'manual', created_by: senior.uid, owner_id: senior.uid, is_test: true,
        profile: { ...base, full_name: 'Probe Employer Person', projects: [
          { years: 'July 2015 – April 2017', type: 'shipyard fabrication', country: 'Romania', employer: 'SC Vard Brăila SA' },
          { years: '2017-2020', type: 'industrial projects', country: 'Italy', employer: 'Saver Saldature' },
        ] },
      },
      {
        workspace_id: W, reference_code: CONTROL, trade_code: 'F', full_name: 'Probe Other Person', trade: 'Plate worker',
        created_via: 'manual', created_by: senior.uid, owner_id: senior.uid, is_test: true,
        profile: { ...base, full_name: 'Probe Other Person', projects: [
          { years: '2019-2023', type: 'shipyard', country: 'Denmark', employer: 'Esbjerg Shipyard' },
        ] },
      },
    ]).select('id'), 'candidates');

    for (const width of [1500, 390] as const) {
      console.log(`\n--- ${width}px ---`);
      const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, hasTouch: width === 390, isMobile: width === 390 });
      const p = await ctx.newPage();
      await signIn(p, senior);
      await p.goto(`${BASE}/app/radar?tab=won&lead=${lead}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(p);

      // The drawer opens on tool 'jd'; the score card only exists once "2 · Score the pool" is
      // chosen, so the button is not on the page until then (2026-09-16: the first run waited 180 s
      // for a badge on a card that was never rendered).
      // Choose the step by its own label — "2 · Score the pool" in the drawer's list — rather than
      // relying on which of two matching buttons comes first in the DOM.
      await p.getByRole('button', { name: /^2 · Score the pool$/ }).click();
      const scoreBtn = p.getByRole('button', { name: /^Score the pool$/ });
      check(await scoreBtn.count() > 0, 'choosing step 2 reveals the "Score the pool" action',
        `landed on ${p.url()}`);
      // Watch the call itself, so a failure says whether the route answered rather than leaving a
      // silent wait to time out.
      const answered = p.waitForResponse((r) => r.url().includes('/api/lead') && r.request().method() === 'POST', { timeout: 180000 });
      await scoreBtn.first().click();
      const res = await answered.catch(() => null);
      const body = res ? await res.json().catch(() => null) : null;
      check(!!res && res.status() === 200, 'POST /api/lead score_pool answered 200',
        res ? `${res.status()} ${JSON.stringify(body?.error ?? '').slice(0, 120)}` : 'no response seen in 180 s');
      const ranked = body?.ranked ?? [];
      check(ranked.length >= 2, 'both seeded candidates were scored', `${ranked.length} ranked`);
      check(ranked.some((r: any) => r.previousEmployer), 'the response carries previousEmployer for the matching candidate',
        JSON.stringify(ranked.map((r: any) => [r.reference_code, r.previousEmployer?.label ?? null])).slice(0, 200));

      await p.waitForSelector('[data-previous-employer]', { timeout: 60000, state: 'attached' })
        .catch(async () => {
          await p.screenshot({ path: `.cache/previous-employer-${width}.png`, fullPage: true });
          check(false, 'the badge reached the score card', `no [data-previous-employer] on screen — screenshot in .cache/previous-employer-${width}.png`);
        });

      const badge = await readable(p, '[data-previous-employer]');
      check(badge.legible, 'the badge is on the score card and reads clearly', `"${badge.text}" ${badge.colour} on ${badge.behind}`);
      check(/worked for this employer before/i.test(badge.text), 'it names the EMPLOYER, never the site', badge.text);
      check(/2015/.test(badge.text), 'it carries the years exactly as the CV prints them', badge.text);

      const badged = await p.locator('[data-previous-employer]').count();
      check(badged === 1, 'only the candidate who shares an employer is badged, not the control', `${badged} badge(s), 2 candidates scored`);

      const tone = await p.locator('[data-previous-employer]').first().getAttribute('data-previous-employer');
      check(tone === 'ok', 'a finished employment reads as past, not as a non-compete warning', String(tone));

      // The one screening question this case earns, on the card that carries the badge.
      // Anchored on the card's own attribute. Filtering divs by text picked the innermost match —
      // the grid inside the card, which holds the badge but not the buttons (2026-09-16).
      const card = p.locator(`[data-scored-candidate="${MATCH}"]`);
      await card.getByRole('button', { name: /Questions for this candidate/i }).click();
      await p.waitForSelector('ol li', { timeout: 180000 });
      const questions = (await p.locator('ol li').allInnerTexts()).map(flat);
      const employerQ = questions.find((q) => /vard br[ăa]ila/i.test(q));
      check(!!employerQ, 'the questions include one about the shared employer, named as the CV spells it',
        employerQ?.slice(0, 130) ?? questions.map((q) => q.slice(0, 40)).join(' | '));
      check(/how did that end|take you back/i.test(employerQ ?? ''),
        'it asks how the employment ended and whether they would be taken back', employerQ?.slice(0, 130));

      const over = await sideways(p);
      check(over <= 1, `at ${width}px nothing scrolls sideways`, `${over}px`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    // clearTestWorkspace empties sends, scores, candidates, documents and the deletion log — not
    // leads and not companies, which no probe had seeded into a throwaway workspace before this
    // one. So this probe removes its own two rows first; widening the shared helper would change
    // cleanup for every probe in the gate, and that is its own decision, not a line in this step.
    // (2026-09-16: without this the workspace survived on companies_workspace_id_fkey.)
    // In foreign-key order, and scores come first: score_pool writes one scores row per candidate
    // pointing at the LEAD, so scores -> leads -> companies. Deleting the lead first fails on
    // scores_lead_id_fkey, which then leaves the company, which then leaves the workspace
    // (2026-09-16, both strands).
    const mine: string[] = [];
    const { data: seededLeads } = await admin.from('leads').select('id').eq('workspace_id', W);
    const leadIds = (seededLeads ?? []).map((l: any) => l.id);
    if (leadIds.length) {
      const { error } = await admin.from('scores').delete().in('lead_id', leadIds);
      if (error) mine.push(`the scores written against the seeded lead were not deleted: ${error.message}`);
    }
    const { error: leadGone } = await admin.from('leads').delete().eq('workspace_id', W);
    if (leadGone) mine.push(`the seeded lead was not deleted: ${leadGone.message}`);
    const { error: coGone } = await admin.from('companies').delete().eq('workspace_id', W);
    if (coGone) mine.push(`the seeded company was not deleted: ${coGone.message}`);
    const left = [...mine, await removeProbe(admin, senior.uid, W, null, { clearContent: true })].filter(Boolean).join('; ');
    console.log(left ? `\ncleanup left something behind: ${left}` : '\nthe probe workspace, its account and everything seeded were removed');
    if (left) failures++;
  }

  console.log(failures ? `\nprevious-employer probe: ${failures} FAILED` : '\nprevious-employer probe: all checks passed');
  process.exit(failures ? 1 : 0);
})();
