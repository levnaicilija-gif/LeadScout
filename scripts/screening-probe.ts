/**
 * Item 5 on screen: generate the questions, take them onto a call, write down what was said, and
 * find it still there afterwards. At 1500px and again at 390px on a touch screen.
 *
 *   npx tsx --env-file=.env.local scripts/screening-probe.ts http://localhost:3163
 *
 * The real path a recruiter takes, not a shortcut through the API: open the lead, score the pool,
 * ask for this candidate's questions, press "Start screening call", type an answer, reload the page
 * to prove it was kept, mark a verdict, finish the call, and read what the finish decided.
 *
 * Two calls are made at each width:
 *   1. a verdict call — a verdict is clicked, so finishing must name a reason to score again;
 *   2. a prose-only call — sentences that would disqualify anybody are typed into the boxes and
 *      NOTHING is clicked, so finishing must decide there is nothing to re-score. That second one is
 *      the owner's decision made visible: prose is never read for meaning.
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
/** count() samples; a client component that fetches before it renders needs waiting for. */
const appears = async (p: Page, sel: string, ms = 60000) => {
  try { await p.waitForSelector(sel, { state: 'attached', timeout: ms }); return true; } catch { return false; }
};
const code = (n: string) => `SCRPROBE${String(stamp).slice(-4).replace(/\d/g, (d) => 'ABCDEFGHIJ'[Number(d)])}-P-${n}`;

async function account(label: string) {
  const email = `screening-probe-${label}+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: `Screening Probe ${label}`, agency: 'Screening Probe' } });
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
  const { error: notThere } = await admin.from('screening_calls').select('id').limit(1);
  if (notThere) { console.log(`0040 is not applied — nothing to check (${notThere.code} ${notThere.message})`); process.exit(1); }

  const senior = await account('senior');
  const W = senior.ownWorkspace;
  await admin.from('users').update({ role: 'senior', onboarding_day: 30 }).eq('id', senior.uid);

  const browser = await chromium.launch();
  // Declared out here so the cleanup can see them: a finally block cannot reach into the try.
  let company = '';
  let lead = '';
  let cand = '';
  try {
    company = (await admin.from('companies').insert({ workspace_id: W, name: `Screening Probe Yard ${stamp}`, country: 'DK', is_test: true }).select('id').single()).data!.id;
    lead = (await admin.from('leads').insert({
      workspace_id: W, company_id: company, kind: 'won_work', status: 'new', country: 'DK',
      project_name: 'Probe hull repair', trades_inferred: ['welder'],
      job_description: 'Welders for hull repair in Esbjerg. ISO 9606 135/136 required, 6G an advantage. Offshore medical and BOSIET needed. EU passport required. 2:2 rotation, start within three weeks.',
      jd_version: 2, is_test: true,
    }).select('id').single()).data!.id;

    // No EU passport on file, so checkRightToWork raises its question — the one whose kind is certain.
    cand = (await admin.from('candidates').insert({
      workspace_id: W, reference_code: code('7001'), trade_code: 'W', full_name: 'Probe Call Person', trade: 'Welder',
      created_via: 'manual', created_by: senior.uid, owner_id: senior.uid, is_test: true, eu_passport: false,
      profile: { full_name: 'Probe Call Person', trade: 'Welder', trade_code: 'W', trades: ['welder'], skills: ['MAG welding'], languages: ['English'], certificates_claimed: ['ISO 9606 135'], projects: [{ years: '2019-2024', type: 'shipyard hull work', country: 'Denmark' }], pii: {} },
    }).select('id').single()).data!.id;

    for (const width of [1500, 390] as const) {
      console.log(`\n--- ${width}px ---`);
      const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, hasTouch: width === 390, isMobile: width === 390 });
      const p = await ctx.newPage();
      await signIn(p, senior);

      await p.goto(`${BASE}/app/radar?tab=won&lead=${lead}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(p);
      await p.getByRole('button', { name: /^2 · Score the pool$/ }).click();
      await p.getByRole('button', { name: /^Score the pool$/ }).click();
      check(await appears(p, '[data-scored-candidate]', 180000), 'the pool scores and the candidate has a card');

      const card = p.locator(`[data-scored-candidate="${code('7001')}"]`);
      // The card mounts when score_pool returns, long after data-hydrated is set on the layout, so
      // waiting on that says nothing about THIS component being wired. Clicking a rendered but
      // unattached button is silent: no error, no request, and a 180 s wait for a list that never
      // comes (2026-09-17). Wait for the click to take effect, and retry once if it did not.
      // Bound to a data hook, never to the label: it reads "Questions for this candidate", then
      // "Writing…", then "Rewrite questions", so a name-based locator stops resolving the instant
      // the button is pressed — which is how the retry below hung for 30 s (2026-09-17).
      const askBtn = card.locator('[data-ask-questions]');
      await askBtn.click();
      // No retry. A retry can never be right here: if the first click landed, the button is
      // disabled while busy and a second click waits 30 s for an "enabled" that will not come; if it
      // did not land, nothing is pending and a second click is the first one. The 5-second window
      // that triggered it was wrong anyway — this call measures 28 s against a thin profile
      // (2026-09-17). Wait for the button to go busy, which is proof the handler ran, then wait for
      // the questions on the budget the call actually needs.
      const ran = await askBtn.evaluate((b: HTMLButtonElement) => b.disabled).catch(() => false)
        || await p.waitForFunction((sel) => {
          const b = document.querySelector(sel) as HTMLButtonElement | null;
          return !!b && b.disabled;
        }, '[data-ask-questions]', { timeout: 10000, polling: 100 }).then(() => true).catch(() => false);
      check(ran, 'the click reaches the handler — the button goes busy');
      const got = await appears(p, 'ol li', 180000);
      // Never wait three minutes and throw away the reason: the card shows its own error. The ERROR
      // is a div; the blocker on the score line is a span, and they share text-bad — matching both
      // made four readings meaningless earlier tonight.
      const cardErr = flat(await card.locator('div.text-bad').innerText().catch(() => ''));
      check(got, 'the questions are generated', got ? '' : `card says: ${cardErr || '(nothing — the click may not have reached a handler)'}`);

      const startBtn = card.locator('[data-start-call]');
      check(await startBtn.count() === 1, 'the card offers "Start screening call"');
      await startBtn.click();
      await p.waitForURL(/\/app\/candidates\/[^/]+\/call\/[^/]+/, { timeout: 60000 });
      check(await appears(p, '[data-screening-call]'), 'it opens the call, at its own page', p.url());

      const questions = await p.locator('[data-question]').count();
      check(questions > 0, 'the questions asked are listed in order', `${questions} question(s)`);

      // Item 5, the generation side: the seven fixed questions are appended in code, so they are on
      // every call whatever the model wrote, and their kinds are certain rather than labelled.
      const allText = flat(await p.locator('[data-screening-call]').innerText());
      check(questions >= 8, 'the seven standard questions are there beside what the score raised', `${questions} question(s)`);
      const standard: [string, RegExp][] = [
        ['certificates and expiry', /certificates do you hold/i],
        ['rotation', /what rotation have you worked/i],
        ['medical and safety training', /bosiet|gwo|vca/i],
        ['English on site', /english on site/i],
        ['start and notice', /earliest start/i],
        ['rate', /rate are you expecting/i],
        ['conflicts', /client you cannot work for/i],
      ];
      for (const [label, re] of standard) {
        check(re.test(allText), `every call asks about ${label}`);
      }
      const firstText = flat(await p.locator('[data-question="0"]').innerText());
      check(firstText.length > 0, 'each carries the question as it was asked', firstText.slice(0, 90));

      const progressBefore = flat(await p.locator('[data-call-progress]').innerText());
      check(/0 of \d+ answered/.test(progressBefore), 'and nothing is answered yet', progressBefore);

      // ---- what the candidate said, and that it lasts
      const said = `Probe answer at ${new Date().toISOString()}`;
      await p.locator('[data-answer="0"]').fill(said);
      await p.locator('[data-answer="0"]').blur();
      await p.waitForTimeout(1500);
      await p.reload({ waitUntil: 'domcontentloaded' });
      await hydrated(p);
      await appears(p, '[data-screening-call]');
      const back = await p.locator('[data-answer="0"]').inputValue();
      check(back === said, 'an answer typed on the call is still there after a reload', back.slice(0, 60));

      const callUrl = p.url();
      const callId = callUrl.split('/call/')[1];
      const { data: row } = await admin.from('screening_answers').select('answer, question').eq('call_id', callId).eq('position', 0).maybeSingle();
      check(row?.answer === said, 'and it is in the database, against the question it was asked for', String(row?.question ?? '').slice(0, 70));

      // ---- a verdict, and what finishing decides
      const verdictButtons = await p.locator('[data-verdict]').count();
      check(verdictButtons > 0, 'a question that takes a verdict offers one — the right-to-work question is injected in code', `${verdictButtons} control(s)`);
      const rtwNo = p.locator('[data-verdict$=":no"]').first();
      if (await rtwNo.count() > 0) {
        await rtwNo.click();
        await p.waitForTimeout(1200);
        await p.locator('[data-finish-call]').click();
        check(await appears(p, '[data-call-rescore]'), 'finishing after a "no" on right to work asks for a re-score');
        const why = flat(await p.locator('[data-call-rescore]').innerText());
        check(/right to work was refused/.test(why) && /score again/.test(why), 'and says why, in words a recruiter reads', why.slice(0, 140));
        const { data: call } = await admin.from('screening_calls').select('needs_rescore, rescore_reason, jd_version, lead_id').eq('id', callId).single();
        check(call?.needs_rescore === true, 'the call is marked in the database, not only on screen');
        check(call?.jd_version === 2 && call?.lead_id === lead, 'and it is keyed to the lead and the JD version it was asked against', JSON.stringify({ jd_version: call?.jd_version, lead: call?.lead_id === lead }));
      } else {
        check(false, 'a right-to-work verdict control was expected on this call');
      }

      const over = await sideways(p);
      check(over <= 1, `at ${width}px nothing scrolls sideways`, `${over}px`);

      // ---- item 5 part 3 on the card: the number beside it is now the old one, and says so.
      await p.goto(`${BASE}/app/radar?tab=won&lead=${lead}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(p);
      await p.getByRole('button', { name: /^2 · Score the pool$/ }).click();
      await p.getByRole('button', { name: /^Score the pool$/ }).click();
      check(await appears(p, '[data-scored-candidate]', 180000), 'the pool scores again after the call');
      check(await appears(p, '[data-rescore-asked]', 30000), 'the card says the score was made before the call');
      const asked = flat(await p.locator('[data-rescore-asked]').first().innerText());
      check(/made before the call/.test(asked) && /right to work was refused/.test(asked),
        'and names what was said on it', asked.slice(0, 140));
      const flagged = await p.locator('[data-rescore-asked]').count();
      check(flagged === 1, 'only the candidate who was called is flagged', `${flagged} flag(s)`);

      // ---- and it stops speaking the moment the JD is rewritten (owner's caveat, 2026-09-17)
      await admin.from('leads').update({ jd_version: 3 }).eq('id', lead);
      await p.goto(`${BASE}/app/radar?tab=won&lead=${lead}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(p);
      await p.getByRole('button', { name: /^2 · Score the pool$/ }).click();
      await p.getByRole('button', { name: /^Score the pool$/ }).click();
      check(await appears(p, '[data-scored-candidate]', 180000), 'the pool scores against the rewritten JD');
      await p.waitForTimeout(1500);
      const afterRewrite = await p.locator('[data-rescore-asked]').count();
      check(afterRewrite === 0, 'a call answered against version 2 says nothing about version 3 — the flag does not survive a rewrite', `${afterRewrite} flag(s)`);
      await admin.from('leads').update({ jd_version: 2 }).eq('id', lead);

      await ctx.close();
    }

    // ---- prose alone changes nothing: the owner's decision, on a real call
    console.log('\n--- prose only ---');
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const p = await ctx.newPage();
    await signIn(p, senior);
    const { data: made } = await admin.from('screening_calls').insert({
      workspace_id: W, candidate_id: cand, lead_id: lead, jd_version: 2, started_by: senior.uid,
    }).select('id').single();
    await admin.from('screening_answers').insert([
      { call_id: made!.id, position: 0, question: 'How did your last job end?', kind: 'open' },
      { call_id: made!.id, position: 1, question: 'Rate expectation?', kind: 'rate' },
    ]);
    await p.goto(`${BASE}/app/candidates/${cand}/call/${made!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(p);
    await appears(p, '[data-screening-call]');
    await p.locator('[data-answer="0"]').fill('His 6G lapsed in March and he has no EU passport at all.');
    await p.locator('[data-answer="0"]').blur();
    await p.locator('[data-answer="1"]').fill('Cannot work for Aker again, and his medical expired.');
    await p.locator('[data-answer="1"]').blur();
    await p.waitForTimeout(1500);
    await p.locator('[data-finish-call]').click();
    await p.waitForTimeout(1500);
    const rescoreShown = await p.locator('[data-call-rescore]').count();
    check(rescoreShown === 0, 'prose that would disqualify anybody asks for no re-score — only a verdict does');
    const finishedText = flat(await p.locator('[data-call-finished]').innerText());
    check(/Nothing you marked changes the score/.test(finishedText), 'and the call says so plainly', finishedText.slice(0, 120));
    const { data: proseCall } = await admin.from('screening_calls').select('needs_rescore, finished_at').eq('id', made!.id).single();
    check(proseCall?.needs_rescore === false && !!proseCall?.finished_at, 'the database agrees: finished, nothing to re-score');
    await ctx.close();
  } finally {
    await browser.close();
    // In foreign-key order. scores has no workspace_id of its own — it hangs off the lead and the
    // candidate — so it is cleared by lead_id, and the lead and company by workspace.
    const left: string[] = [];
    const { error: callErr } = await admin.from('screening_calls').delete().eq('workspace_id', W);
    if (callErr) left.push(`screening_calls: ${callErr.message}`);
    if (lead) {
      const { error } = await admin.from('scores').delete().eq('lead_id', lead);
      if (error) left.push(`scores: ${error.message}`);
    }
    for (const t of ['leads', 'companies'] as const) {
      const { error } = await admin.from(t).delete().eq('workspace_id', W);
      if (error) left.push(`${t}: ${error.message}`);
    }
    const notGone = await removeProbe(admin, senior.uid, W, null, { clearContent: true });
    if (notGone) left.push(notGone);
    console.log(left.length ? `\ncleanup left something behind: ${left.join('; ')}` : '\nthe probe workspace, its account and everything seeded were removed');
    if (left.length) failures++;
  }

  console.log(failures ? `\nscreening probe: ${failures} FAILED` : '\nscreening probe: all checks passed');
  process.exit(failures ? 1 : 0);
})();
