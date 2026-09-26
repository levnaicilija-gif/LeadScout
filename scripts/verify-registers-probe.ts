/**
 * Item 23 on screen: CSWIP, AMPP and IRATA certificates through the real Verify drop zone, as a signed-in recruiter, at
 * 1500px and at 390px on a touch screen.
 *
 *   npx tsx --env-file=.env.local scripts/verify-registers-probe.ts https://leadscout-rfbt.vercel.app
 *
 * No real certificate for these schemes is on file, so the probe renders three SPECIMEN PDFs at run time — every one says
 * it is a test document, and every number on them is made up — and drops them into Verify. The document read is the real
 * model call (metered, item 16); the lookup goes to the real registers with made-up numbers, so no register can confirm
 * them and each card must say why, never invent a verdict:
 *   - AMPP searches its public registry and says a number that is not listed is not a verdict;
 *   - CSWIP says it needs the holder's date of birth (no passport on file);
 *   - IRATA says its tool is behind a reCAPTCHA and is checked by hand.
 * Each card must show the three layers — what the document says, the decoded explanation, the confirmation — land on
 * "pending issuer — email drafted", and the page must not scroll sideways. The database must hold the same states, and the
 * model cost per verification is read from cost_log.
 *
 * A throwaway account with its own test-marked workspace; everything it made is removed afterwards and a leftover fails
 * the run. Never touches the real workspace.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { Document, Page, Text, renderToBuffer } from '@react-pdf/renderer';
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page as PwPage } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe, probeAdmin } from '../src/lib/test-data';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const EMAIL = `verify-registers-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = `probe-${Date.now()}-0123456789`;
const admin = probeAdmin();

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };

/**
 * meaning — the decoded layer's own words for this scheme, from the certificate library, never printed on the document.
 * After 0034 (applied 2026-09-15): instructions — the body's corrected instructions; stale — 0008's, which must be gone
 * (case-sensitive: IRATA's own note says "not searched automatically", which is right); library — the corrected "How it
 * is checked" line; emailTo — where the drafted email goes.
 */
type Spec = { body: 'cswip' | 'ampp' | 'irata'; file: string; lines: string[]; meaning: RegExp; reason: RegExp; instructions: RegExp; stale: RegExp; library: RegExp; emailTo: RegExp };
const SPECIMEN = 'SPECIMEN — SOFTWARE TEST DOCUMENT — NOT A REAL QUALIFICATION';
const SPECS: Spec[] = [
  {
    body: 'cswip', file: 'cswip-specimen.pdf', meaning: /TWI certification\. The standard weld inspection grade/i, reason: /date of birth/i,
    instructions: /When TWI cannot answer, we draft an email to verification@twi\.co\.uk/, stale: /CSWIP verifies on certificate number AND date of birth, so the passport must be on file first/,
    library: /How it is checked\s*TWI's CSWIP register — by number and date of birth/i, emailTo: /To verification@twi\.co\.uk/,
    lines: ['TWI Certification Ltd', 'CSWIP', 'Certificate of Competence', 'CSWIP 3.1 Welding Inspector', 'Holder: Probe Fixturesson', 'Certificate number: 000000', 'Date of issue: 01/01/2024', 'Expiry date: 01/01/2029'],
  },
  {
    body: 'ampp', file: 'ampp-specimen.pdf', meaning: /AMPP Coating Inspector Program level 2/i, reason: /not a verdict/i,
    instructions: /Searched automatically in AMPP's public credential registry by certification number and surname/, stale: /needs an AMPP account/,
    library: /How it is checked\s*AMPP's public credential registry — lists current holders who opted in/i, emailTo: /To customersupport@ampp\.org/,
    lines: ['AMPP — Association for Materials Protection and Performance', 'Certified Coating Inspector — Level 2', 'Holder: Probe Fixturesson', 'Certification number: 000000', 'Issued: 2024-01-01', 'Expires: 2027-01-01'],
  },
  {
    body: 'irata', file: 'irata-specimen.pdf', meaning: /IRATA certification\. Level 2/i, reason: /reCAPTCHA/i,
    instructions: /IRATA's verification tool puts a reCAPTCHA in front of every search, so it is checked by hand/, stale: /Searched automatically on IRATA TechConnect/,
    library: /How it is checked\s*IRATA TechConnect — checked by hand \(reCAPTCHA\)/i, emailTo: /No address on file for this body/,
    lines: ['IRATA International', 'Industrial Rope Access Trade Association', 'Rope Access Technician — Level 2', 'Holder: Probe Fixturesson', 'IRATA No: 2/00000', 'Issued: 01/01/2024', 'Valid until: 01/01/2027'],
  },
];

async function specimens(dir: string) {
  for (const s of SPECS) {
    const doc = React.createElement(Document, null,
      React.createElement(Page, { size: 'A4', style: { padding: 48, fontSize: 14 } },
        ...s.lines.map((l, i) => React.createElement(Text, { key: i, style: { marginBottom: 10, fontSize: i === 0 ? 20 : 14 } }, l)),
        React.createElement(Text, { style: { marginTop: 40, fontSize: 9, color: '#666' } }, SPECIMEN)));
    fs.writeFileSync(path.join(dir, s.file), await renderToBuffer(doc as any));
  }
}

async function dropAndRead(page: PwPage, dir: string, width: number) {
  const lookups: any[] = [];
  const onResponse = async (r: any) => {
    if (!/\/api\/verify\/lookup/.test(r.url())) return;
    try { lookups.push({ status: r.status(), body: await r.json() }); } catch { lookups.push({ status: r.status(), body: null }); }
  };
  page.on('response', onResponse);
  // tsx names inner functions through a __name helper that does not exist inside the page; page.evaluate threw on it.
  await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || function (f) { return f; };' });
  await page.goto(`${BASE}/app/verify`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', undefined, { timeout: 60000 }).catch(() => {});
  await page.locator('input[type=file]').first().setInputFiles(SPECS.map((s) => path.join(dir, s.file)));
  const started = Date.now();
  // The section labels are CSS-uppercased, and innerText returns them as drawn ("CONFIRMATION"), so every match here
  // ignores case. The busy marker is the page's own "nothing still running", and the three lookups must have answered.
  const settled = await page.waitForFunction(
    () => !!document.querySelector('[data-verify-busy="false"]')
      && (document.body.innerText.match(/confirmation/gi) ?? []).length >= 3
      && !/confirming…|checking…/i.test(document.body.innerText),
    undefined, { timeout: 240000 },
  ).then(() => true).catch(() => false);
  // The explanations load on their own after the cards render.
  await page.waitForFunction(() => !/Reading the code…/i.test(document.body.innerText), undefined, { timeout: 30000 }).catch(() => {});
  page.off('response', onResponse);
  check(settled, `at ${width}px Verify settles with three certificate cards`, `${Math.round((Date.now() - started) / 1000)}s`);
  await page.screenshot({ path: path.join('.cache', `verify-registers-${width}.png`), fullPage: true }).catch(() => {});

  const cards = await page.evaluate(() => {
    const isCard = (el: Element) => /what the document says/i.test((el as HTMLElement).innerText) && /confirmation/i.test((el as HTMLElement).innerText);
    return [...document.querySelectorAll('div')].filter((d) => isCard(d) && ![...d.children].some(isCard)).map((d) => d.innerText.replace(/\s+/g, ' '));
  });
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (sideways) {
    // Name what sticks out, so a sideways scroll is a finding with a cause, not a guess.
    // Only what can widen the page: an element past the edge with no ancestor that clips or scrolls it. The first version
    // listed the rail's links, which sit inside the nav's own horizontal scroll and cannot widen anything.
    const wide = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const clipped = (el: Element) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) return true;
        }
        return false;
      };
      return [...document.querySelectorAll('body *')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1 && !clipped(el); })
        .filter((el) => ![...el.children].some((c) => (c as HTMLElement).getBoundingClientRect().right > vw + 1 && !clipped(c)))
        .slice(0, 8)
        .map((el) => `<${el.tagName.toLowerCase()} class="${(el.getAttribute('class') ?? '').slice(0, 70)}"> right ${Math.round(el.getBoundingClientRect().right)}px: ${((el as HTMLElement).innerText ?? '').slice(0, 90).replace(/\s+/g, ' ')}`);
    });
    const by = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(`  ...  at ${width}px the page is ${by}px wider than the screen; unclipped elements past the edge:\n        ${wide.join('\n        ') || '(none unclipped)'}`);
  }
  for (const s of SPECS) {
    const card = cards.find((c) => s.meaning.test(c));
    check(!!card, `at ${width}px a ${s.body.toUpperCase()} card is on screen, decoded from the library`, `${cards.length} certificate card(s)`);
    if (!card) continue;
    check(/what the document says/i.test(card) && /what this certificate means/i.test(card) && /from the library/i.test(card) && !/Unrecognised — check/i.test(card) && /confirmation/i.test(card),
      `at ${width}px the ${s.body.toUpperCase()} card shows all three layers: what the document says, what the library says it means, the confirmation`, card.slice(0, 220));
    check(/pending issuer — email drafted/.test(card), `at ${width}px the ${s.body.toUpperCase()} card lands on "pending issuer — email drafted", not a verdict`, (card.match(/Status (.{0,60})/) ?? [])[1] ?? '');
    check(s.reason.test(card), `at ${width}px the ${s.body.toUpperCase()} card says why no register confirmed it`, (card.match(/Notes (.{0,200})/) ?? [])[1] ?? card.slice(-200));
    check(!/verified on register|not on the issuer register/.test(card), `at ${width}px the ${s.body.toUpperCase()} card claims no register verdict`);
    check(s.instructions.test(card) && !s.stale.test(card), `at ${width}px the ${s.body.toUpperCase()} card shows 0034's instructions, not the old wording`, (card.match(/pending issuer — email drafted (.{0,170})/) ?? [])[1] ?? '');
    check(s.library.test(card), `at ${width}px the ${s.body.toUpperCase()} card's "How it is checked" line is 0034's`, (card.match(/How it is checkeds*(.{0,110})/i) ?? [])[1] ?? '');
    check(s.emailTo.test(card), `at ${width}px the ${s.body.toUpperCase()} card's drafted email goes where 0034 says`, (card.match(/send the emails*(.{0,60})/i) ?? [])[1] ?? '');
  }
  check(!sideways, `Verify at ${width}px does not scroll sideways`);
  return lookups;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-registers-'));
  await specimens(dir);
  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Verify Registers Probe', agency: 'Verify Registers Probe' } });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);
  const followProblem = await followAllForProbe(admin, uid);
  if (followProblem) console.log(`  ...  ${followProblem}`);
  const startedAt = new Date().toISOString();

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});
    check(/\/app\//.test(page.url()), 'signed in as a recruiter in a test workspace', page.url());

    const desktop = await dropAndRead(page, dir, 1500);
    const byBody = new Map(desktop.map((l) => [l.body?.certBody?.body, l]));
    for (const s of SPECS) {
      const l = byBody.get(s.body);
      check(l?.status === 200 && l.body?.state === 'pending_issuer' && s.reason.test(l.body?.verification?.notes ?? ''), `the ${s.body.toUpperCase()} lookup answered pending_issuer with its reason`, JSON.stringify({ status: l?.status, state: l?.body?.state, notes: String(l?.body?.verification?.notes ?? '').slice(0, 160) }));
    }

    const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await dropAndRead(await phone.newPage(), dir, 390);
    await phone.close();

    // The rows behind the screen.
    const { data: docs } = await admin.from('documents').select('id, cert_body, cert_state, verifications(state, result, checked_where)').eq('workspace_id', workspace).eq('type', 'certificate');
    const perBody = SPECS.map((s) => ({ body: s.body, docs: (docs ?? []).filter((d: any) => d.cert_body === s.body) }));
    for (const p of perBody) {
      const states = p.docs.map((d: any) => `${d.cert_state}/${d.verifications?.[0]?.state}/${d.verifications?.[0]?.result}`);
      check(p.docs.length === 2 && p.docs.every((d: any) => d.cert_state === 'pending_issuer' && d.verifications?.[0]?.state === 'pending_issuer' && d.verifications?.[0]?.result === 'not_supported'), `the database holds both ${p.body.toUpperCase()} checks as pending_issuer / not_supported`, states.join(', '));
    }
    const { data: cost } = await admin.from('cost_log').select('kind, eur, detail').eq('workspace_id', workspace).gte('created_at', startedAt);
    const reads = (cost ?? []).filter((c: any) => c.kind === 'document-read');
    const eur = reads.reduce((a: number, c: any) => a + Number(c.eur), 0);
    const other = (cost ?? []).filter((c: any) => c.kind !== 'document-read');
    check(reads.length >= 6 && reads.every((c: any) => String(c.detail).startsWith('test workspace')), 'every certificate read was metered, as test traffic', `${reads.length} attempt(s)`);
    check(other.length === 0, 'the register lookups made no model call', other.map((c: any) => c.kind).join(', '));
    console.log(`  ...  model cost: ${reads.length} document-read attempt(s) for 6 certificates, €${eur.toFixed(4)} — €${(eur / 6).toFixed(4)} per verification`);
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
    const leftBehind = await removeProbe(admin, uid, workspace, null, { clearContent: true });
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); } else console.log('\nprobe user, its workspace and its documents removed');
  }
  console.log(failures === 0 ? 'verify registers probe: all checks passed' : `verify registers probe: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
