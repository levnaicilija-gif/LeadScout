/**
 * Today raises a certificate at 60, 30 and 7 days and once it has gone — each with the renewal
 * message actually written out.
 *
 *   npx tsx --env-file=.env.local scripts/cert-expiry-probe.ts http://localhost:3163
 *
 * Five certificates are SEEDED at five distances, because the real data has none of them: the whole
 * candidates table is empty and the thirteen documents on file are attached to nobody. A probe reading
 * production here would raise nothing and pass.
 *
 *   90 days   no alert at all — the band starts at 60, and an alert on everything is an alert on nothing
 *   45 days   the 60-day notice
 *   20 days   the 30-day notice
 *    3 days   the 7-day notice
 *  -10 days   expired, which reads differently because it is a different conversation
 *
 * And the one that matters most: a certificate whose expiry exists ONLY as the text printed on the
 * document raises NOTHING. documents.extracted.expiry is not a date — handing "03.09.2028" to Postgres
 * is what stored 9 March, six months early, until dab0828 — so an alert built on it would fire on a
 * day nobody can stand behind. Silence is the correct answer there, and silence is easy to get by
 * accident, which is why the other five are seeded alongside it.
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
const boundaryWhy = async (p: Page) => {
  if (await p.locator('[data-error-boundary]').count() === 0) return '';
  return `error boundary — ${flat(await p.locator('[data-error-reference]').first().innerText().catch(() => ''))}`;
};
const dayAt = (n: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) + n * 86400000).toISOString().slice(0, 10);

async function account() {
  const email = `cert-expiry+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: 'Cert Expiry Probe', agency: 'Cert Expiry Probe' } });
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
  const { data: old } = await admin.from('users').select('id, workspace_id').like('name', 'Cert Expiry Probe%');
  for (const u of old ?? []) { console.log('sweeping a leftover probe account'); await removeProbe(admin, u.id, u.workspace_id, null, { clearContent: true }); }

  const who = await account();
  const browser = await chromium.launch();
  try {
    const CASES = [
      { key: 'far', days: 90, expect: null },
      { key: 'sixty', days: 45, expect: '60-day' },
      { key: 'thirty', days: 20, expect: '30-day' },
      { key: 'seven', days: 3, expect: '7-day' },
      { key: 'gone', days: -10, expect: 'EXPIRED' },
    ] as const;
    const refs: Record<string, string> = {};

    for (const c of CASES) {
      const { data: cand, error: cErr } = await admin.from('candidates').insert({
        workspace_id: who.workspace, full_name: `Expiry ${c.key} ${stamp}`, trade: 'welder',
        reference_code: `RFBT-Y-${String(stamp).slice(-6)}${CASES.indexOf(c as any)}`, is_test: true,
      }).select('id, reference_code').single();
      if (cErr) throw new Error(`seeding candidate ${c.key} failed: ${cErr.message}`);
      refs[c.key] = cand!.reference_code;
      const { data: doc, error: dErr } = await admin.from('documents').insert({
        workspace_id: who.workspace, candidate_id: cand!.id, type: 'certificate', cert_body: 'frosio',
        storage_path: `probe/${stamp}/${c.key}.pdf`, extracted: { number: `NO-${c.key}` }, cert_state: 'verified_register', is_test: true,
      }).select('id').single();
      if (dErr) throw new Error(`seeding document ${c.key} failed: ${dErr.message}`);
      const { error: vErr } = await admin.from('verifications').insert({
        document_id: doc!.id, method: 'manual', result: 'valid', state: 'verified_register', valid_until: dayAt(c.days),
      });
      if (vErr) throw new Error(`seeding verification ${c.key} failed: ${vErr.message}`);
    }

    // The printed-text-only case: no valid_until at all, an expiry only as the document prints it.
    const { data: pCand } = await admin.from('candidates').insert({
      workspace_id: who.workspace, full_name: `Expiry printed ${stamp}`, trade: 'welder',
      reference_code: `RFBT-Y-${String(stamp).slice(-6)}9`, is_test: true,
    }).select('id, reference_code').single();
    refs.printed = pCand!.reference_code;
    const { data: pDoc } = await admin.from('documents').insert({
      workspace_id: who.workspace, candidate_id: pCand!.id, type: 'certificate', cert_body: 'frosio',
      // The printed text is deliberately one that WOULD parse — an ISO-looking date 20 days out. With
      // "03.09.2028" this check was vacuous: that string parses to nothing, so a version that wrongly
      // read the printed text still raised no alert and the check passed for the wrong reason. Proved
      // by mutation: falling back to extracted.expiry now produces a 30-day notice and fails here.
      storage_path: `probe/${stamp}/printed.pdf`, extracted: { number: 'NO-printed', expiry: dayAt(20) }, cert_state: 'verified_register', is_test: true,
    }).select('id').single();
    await admin.from('verifications').insert({ document_id: pDoc!.id, method: 'manual', result: 'valid', state: 'verified_register', valid_until: null });
    console.log(`seeded ${CASES.length} certificates at 90/45/20/3/-10 days, and one whose expiry is printed text only`);

    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const page = await ctx.newPage();
    await signIn(page, who);
    await page.goto(`${BASE}/app/today`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);
    const why = await boundaryWhy(page);
    check(!why, 'Today renders — no error boundary', why);
    if (why) throw new Error('the page did not render, so nothing below can be judged');

    const body = flat(await page.locator('body').innerText());
    const rowFor = (ref: string) => body.match(new RegExp(`${ref}[^|]{0,160}`))?.[0] ?? '';

    console.log('\n--- each distance raises its own band, and only its own ---');
    check(!body.includes(refs.far), '90 days out raises nothing at all', refs.far);
    check(/60-day notice/.test(rowFor(refs.sixty)), '45 days out is the 60-day notice', rowFor(refs.sixty).slice(0, 90));
    check(/30-day notice/.test(rowFor(refs.thirty)), '20 days out is the 30-day notice', rowFor(refs.thirty).slice(0, 90));
    check(/7-day notice/.test(rowFor(refs.seven)), '3 days out is the 7-day notice', rowFor(refs.seven).slice(0, 90));
    check(/EXPIRED/.test(rowFor(refs.gone)), 'and one that has gone reads EXPIRED', rowFor(refs.gone).slice(0, 90));
    check(!/60-day|30-day/.test(rowFor(refs.seven)), 'a 7-day certificate raises ONE alert, not three stacked ones', rowFor(refs.seven).slice(0, 90));

    console.log('\n--- an expiry that is only printed text raises nothing ---');
    // Silence is the right answer, and silence is easy to get by accident — the five above are what
    // make this assertion mean something rather than agreeing with an empty page.
    check(!body.includes(refs.printed), 'a certificate with no valid_until is not alerted on', refs.printed);

    console.log('\n--- the renewal message is actually written, not merely promised ---');
    const drafts = await page.locator('[data-renewal-draft]').count();
    check(drafts >= 4, 'every raised certificate carries a draft', `${drafts} draft(s) for 4 raised`);
    // A <details> is collapsed, and innerText reports nothing for content that is not visible — the
    // words are in the DOM either way, but a check reading them must open the thing a recruiter would
    // open. Opened here rather than read with textContent, so this asserts what is actually readable.
    await page.evaluate(() => document.querySelectorAll('details[data-renewal-draft]').forEach((d) => d.setAttribute('open', '')));
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-draft-subject]') as HTMLElement | null;
      return !!el && el.innerText.trim().length > 0;
    }, undefined, { timeout: 15000 }).catch(() => {});
    const subjects = await page.locator('[data-draft-subject]').allInnerTexts();
    const bodies = await page.locator('[data-draft-body]').allInnerTexts();
    check(subjects.some((s) => /expires on/i.test(s)), 'a subject names the date it goes', subjects[0]?.slice(0, 80) ?? 'none');
    check(subjects.some((s) => /has expired/i.test(s)), 'and the expired one says so instead', subjects.find((s) => /expired/i.test(s))?.slice(0, 80) ?? 'none');
    check(bodies.some((b) => /Cert Expiry Probe/.test(b)), 'the body signs off as the agency, read from the workspace', bodies[0]?.slice(-60) ?? 'none');
    check(bodies.some((b) => /NO-/.test(b)), 'and quotes the certificate number off the document');
    const basis = await page.locator('[data-draft-basis]').first().innerText().catch(() => '');
    check(/valid_until/.test(basis), 'and says which date it was written from', flat(basis).slice(0, 100));
    check(!/mailto:|Send now/i.test(body), 'nothing on the page offers to send it');

    check(await page.evaluate(() => document.querySelectorAll('a a').length) === 0, 'no anchor sits inside another anchor');
    check(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'nothing scrolls sideways at 1500px');
  } finally {
    await browser.close();
    const notGone = await removeProbe(admin, who?.uid, who?.workspace, null, { clearContent: true });
    if (notGone) { console.log(`LEFTOVER: ${notGone}`); failures++; }
  }

  console.log(failures ? `\ncert expiry probe: ${failures} FAILED` : '\ncert expiry probe: all checks passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
