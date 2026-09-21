/**
 * The campaign table shows the state each required document is actually in, and counts who could go.
 *
 *   npx tsx --env-file=.env.local scripts/campaign-docs-probe.ts http://localhost:3163
 *
 * Every state is SEEDED, because none of them exists in the real data: candidates, campaigns,
 * campaign_candidates and sends are all empty, and the thirteen documents on file are attached to
 * nobody. A probe that read production here would assert nothing and pass.
 *
 * Six people, one campaign requiring passport + certificate, each person in a different state, so a
 * cell that renders one word for everybody fails rather than passes:
 *
 *   ready        passport received, certificate verified on the register and in date
 *   noPassport   certificate verified, no passport at all          -> missing
 *   unchecked    both files present, certificate never checked      -> received, not ready
 *   expired      certificate confirmed but valid_until in the past  -> expired, not ready
 *   twoCerts     one expired certificate AND one valid              -> reads by the VALID one
 *   printedOnly  certificate verified, expiry only as printed text  -> verified, no date, still ready
 *
 * The last two are the ones that would pass a careless implementation: an expired certificate must
 * not cancel a valid one, and a certificate whose expiry was never normalised into a real date must
 * not read as expired — that free text is exactly what put a European 03.09.2028 into the database as
 * 9 March before dab0828.
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
const boundaryWhy = async (p: Page) => {
  if (await p.locator('[data-error-boundary]').count() === 0) return '';
  const ref = flat(await p.locator('[data-error-reference]').first().innerText().catch(() => ''));
  return `error boundary on screen — ${ref || 'no reference'}`;
};

const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

async function account() {
  const email = `campaign-docs+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: 'Campaign Docs Probe', agency: 'Campaign Docs Probe' } });
  if (error) throw new Error(`could not create the probe account: ${error.message}`);
  const uid = data.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  await markWorkspaceTest(admin, me?.workspace_id);
  const problem = await followAllForProbe(admin, uid);
  if (problem) throw new Error(problem);
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
  if (!/^\/app(\/|$)/.test(landed) || /^\/app\/onboarding/.test(landed)) throw new Error(`signing in did not reach the app — landed on ${landed}`);
}

(async () => {
  // A previous run killed by Windows leaves the account behind whatever its own handlers did.
  const { data: old } = await admin.from('users').select('id, workspace_id').like('name', 'Campaign Docs Probe%');
  for (const u of old ?? []) {
    console.log('sweeping a leftover probe account');
    await removeProbe(admin, u.id, u.workspace_id, null, { clearContent: true });
    await admin.from('campaigns').delete().eq('workspace_id', u.workspace_id);
  }

  const who = await account();
  const browser = await chromium.launch();
  try {
    const PEOPLE = ['ready', 'noPassport', 'unchecked', 'expired', 'twoCerts', 'printedOnly'] as const;
    const cands: Record<string, string> = {};
    for (const key of PEOPLE) {
      const { data, error } = await admin.from('candidates').insert({
        workspace_id: who.workspace, full_name: `Probe ${key} ${stamp}`, trade: 'welder',
        reference_code: `RFBT-Z-${String(stamp).slice(-6)}${PEOPLE.indexOf(key)}`, is_test: true,
      }).select('id').single();
      if (error) throw new Error(`seeding candidate ${key} failed: ${error.message}`);
      cands[key] = data!.id;
    }

    /** A document plus, optionally, the verification behind it. */
    const doc = async (candidate: string, type: string, opts: { certState?: string; validUntil?: string | null; printed?: string } = {}) => {
      const { data, error } = await admin.from('documents').insert({
        workspace_id: who.workspace, candidate_id: candidate, type,
        storage_path: `probe/${stamp}/${type}-${Math.random().toString(36).slice(2, 8)}`,
        cert_state: opts.certState ?? null,
        extracted: opts.printed ? { expiry: opts.printed } : {},
        is_test: true,
      }).select('id').single();
      if (error) throw new Error(`seeding ${type} failed: ${error.message}`);
      if (opts.certState) {
        const { error: vErr } = await admin.from('verifications').insert({
          document_id: data!.id, method: 'manual', result: 'valid', state: opts.certState, valid_until: opts.validUntil ?? null,
        });
        if (vErr) throw new Error(`seeding a verification failed: ${vErr.message}`);
      }
      return data!.id;
    };

    await doc(cands.ready, 'passport');
    await doc(cands.ready, 'certificate', { certState: 'verified_register', validUntil: day(400) });
    await doc(cands.noPassport, 'certificate', { certState: 'verified_register', validUntil: day(400) });
    await doc(cands.unchecked, 'passport');
    await doc(cands.unchecked, 'certificate');
    await doc(cands.expired, 'passport');
    await doc(cands.expired, 'certificate', { certState: 'verified_register', validUntil: day(-5) });
    await doc(cands.twoCerts, 'passport');
    await doc(cands.twoCerts, 'certificate', { certState: 'verified_register', validUntil: day(-30) });
    await doc(cands.twoCerts, 'certificate', { certState: 'verified_register', validUntil: day(300) });
    await doc(cands.printedOnly, 'passport');
    await doc(cands.printedOnly, 'certificate', { certState: 'verified_register', validUntil: null, printed: '03.09.2028' });

    const { data: camp, error: cErr } = await admin.from('campaigns').insert({
      workspace_id: who.workspace, name: `Probe campaign ${stamp}`, starts_on: day(30),
      required_docs: ['passport', 'certificate'], status: 'active',
    }).select('id').single();
    if (cErr) throw new Error(`seeding the campaign failed: ${cErr.message}`);
    const { error: mErr } = await admin.from('campaign_candidates').insert(PEOPLE.map((k) => ({ campaign_id: camp!.id, candidate_id: cands[k] })));
    if (mErr) throw new Error(`seeding the membership failed: ${mErr.message}`);
    console.log(`seeded 1 campaign (passport + certificate) and ${PEOPLE.length} people, one per state`);

    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const page = await ctx.newPage();
    await signIn(page, who);
    await page.goto(`${BASE}/app/campaigns`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);
    const why = await boundaryWhy(page);
    check(!why, 'Campaigns renders — no error boundary', why);
    if (why) throw new Error('the page did not render, so nothing below can be judged');

    /** The state rendered for one person's one document type. */
    const cellState = async (key: string, type: string) =>
      page.locator(`[data-campaign-row="${cands[key]}"] [data-doc-type="${type}"]`).first().getAttribute('data-doc-state').catch(() => null);
    const packReady = async (key: string) =>
      page.locator(`[data-campaign-row="${cands[key]}"]`).first().getAttribute('data-pack-ready').catch(() => null);

    console.log('\n--- each state reads as itself ---');
    check(await cellState('ready', 'passport') === 'received', 'a passport on file reads received');
    check(await cellState('ready', 'certificate') === 'verified', 'a certificate confirmed on the register reads verified');
    check(await cellState('noPassport', 'passport') === 'missing', 'no passport at all reads missing');
    check(await cellState('unchecked', 'certificate') === 'received', 'a certificate never checked reads received, not verified');
    check(await cellState('expired', 'certificate') === 'expired', 'a certificate past its valid_until reads expired');

    console.log('\n--- the two that a careless implementation gets wrong ---');
    check(await cellState('twoCerts', 'certificate') === 'verified', 'an expired certificate does not cancel a valid one');
    check(await cellState('printedOnly', 'certificate') === 'verified', 'a certificate whose expiry is only printed text is verified, not expired');

    console.log('\n--- ready to send ---');
    check(await packReady('ready') === 'true', 'received where it must be and verified where it can be is ready');
    check(await packReady('twoCerts') === 'true', 'and so is the person holding one valid certificate and one expired');
    check(await packReady('printedOnly') === 'true', 'and the one with no normalised expiry date');
    check(await packReady('noPassport') === 'false', 'a missing passport is not ready');
    check(await packReady('unchecked') === 'false', 'an unchecked certificate is not ready');
    check(await packReady('expired') === 'false', 'an expired certificate is not ready');

    const counted = await page.locator('[data-ready-count]').first().getAttribute('data-ready-count');
    const people = await page.locator('[data-ready-count]').first().getAttribute('data-people-count');
    check(counted === '3' && people === '6', 'the campaign counts exactly the three who could go today', `reads ${counted} of ${people}`);
    const rowsReady = await page.locator('[data-pack-ready="true"]').count();
    check(rowsReady === Number(counted), 'and the count equals the rows marked ready beneath it', `${counted} counted, ${rowsReady} rows`);

    console.log('\n--- a received-only type says why, rather than showing a blank ---');
    const passportCell = flat(await page.locator(`[data-campaign-row="${cands.ready}"] [data-doc-type="passport"]`).first().innerText());
    check(/no register/i.test(passportCell), 'the passport cell names the absence of a register', passportCell.slice(0, 60));
    const title = await page.locator(`[data-campaign-row="${cands.ready}"] [data-doc-type="passport"]`).first().getAttribute('title');
    check(!!title && /no register/i.test(title), 'and carries the full reason', String(title).slice(0, 80));

    check(await page.evaluate(() => document.querySelectorAll('a a').length) === 0, 'no anchor sits inside another anchor');
    check(await sideways(page) <= 0, 'nothing scrolls sideways at 1500px');

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const small = await phone.newPage();
    await signIn(small, who);
    await small.goto(`${BASE}/app/campaigns`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(small);
    const phoneWhy = await boundaryWhy(small);
    check(!phoneWhy, 'Campaigns renders at 390px', phoneWhy);
    if (!phoneWhy) {
      // Name the element, the way design-shots does. A bare "it scrolls sideways" sends the next
      // person hunting; the widest element whose ancestors do not clip it is the answer.
      const over = await small.evaluate(() => {
        const wide = document.documentElement.scrollWidth;
        const clipped = (el: Element) => {
          for (let p = el.parentElement; p; p = p.parentElement) {
            const o = getComputedStyle(p).overflowX;
            if (o === 'auto' || o === 'scroll' || o === 'hidden') return true;
          }
          return false;
        };
        return [...document.querySelectorAll<HTMLElement>('body *')]
          .filter((el) => !clipped(el) && el.getBoundingClientRect().right > wide - 1)
          .slice(0, 3)
          .map((el) => `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(' ').slice(0, 3).join('.')}` : ''} right=${Math.round(el.getBoundingClientRect().right)}`);
      });
      check(await sideways(small) <= 0, 'nothing scrolls sideways at 390px', over.join(' | '));
    }
    await phone.close();
  } finally {
    await browser.close();
    const mine: string[] = [];
    // campaign_candidates cascades from the campaign; documents and verifications from the candidate.
    const { error: campErr } = await admin.from('campaigns').delete().eq('workspace_id', who?.workspace);
    if (campErr) mine.push(`campaigns: ${campErr.message}`);
    const notGone = await removeProbe(admin, who?.uid, who?.workspace, null, { clearContent: true });
    const left = [...mine, notGone].filter(Boolean).join('; ');
    if (left) { console.log(`LEFTOVER: ${left}`); failures++; }
  }

  console.log(failures ? `\ncampaign docs probe: ${failures} FAILED` : '\ncampaign docs probe: all checks passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
