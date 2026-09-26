/**
 * Certificate check: one drop zone, certificates only, nobody touched.
 *
 *   npx tsx --env-file=.env.local scripts/certificate-probe.ts http://localhost:3163
 *
 * The rail's "Certificate check" and Today's "Check a certificate" both used to open Verify — the whole drop
 * zone, every document type, the "attached to nobody" panel and the job-matching panel. This screen answers one
 * question instead, and the point of this probe is that it answers it with VERIFY'S OWN CODE: the same intake,
 * the same issuer lookup, the same three-layer card. Nothing here is a second implementation.
 *
 * What it proves:
 *   1. the page renders, has exactly one drop zone, and carries none of Verify's furniture — no job panel, no
 *      "documents attached to nobody", no CV steps;
 *   2. a real certificate is read and rendered through CertCard, with its layers ("what the document says",
 *      "confirmation") — asserted case-insensitively, because the CSS uppercases those headings and the DOM
 *      text does not;
 *   3. a CV dropped here is REFUSED, not stored, and creates no candidate — the judgement is extractDocument's
 *      own doc_type, so the check is on behaviour rather than on a file name;
 *   4. nothing is attached: the document lands with candidate_id null, which is what lets Verify's orphan panel
 *      offer it to a candidate later (owner's decision 2026-09-18, option A);
 *   5. the rail link and Today's card both point here, not at Verify;
 *   6. Verify itself still takes everything — its drop zone still says so;
 *   7. nothing scrolls sideways at 1500px or 390px.
 * Everything it makes is removed afterwards; a leftover fails the run.
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
const sideways = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/**
 * Empty while the page rendered; otherwise WHAT threw, off the boundary itself (2026-09-20).
 *
 * This probe had no error-boundary read at all, so the auth transient already on file arrived as a
 * locator that never appeared: on 2026-09-20 it passed its first eight checks, then died at the file
 * input with a 30 s TimeoutError, printed no reason and no summary line, and the three
 * AuthRetryableFetchError digests sat unread in next start's own log. Same helper as today-probe's
 * and queue-ids-probe's.
 */
const boundaryWhy = async (p: Page) => {
  if (await p.locator('[data-error-boundary]').count() === 0) return '';
  const ref = flat(await p.locator('[data-error-reference]').first().innerText().catch(() => ''));
  const said = flat(await p.locator('[data-error-boundary]').first().innerText().catch(() => ''));
  return `error boundary on screen — ${ref || 'no reference shown'} — ${said.slice(0, 120)}`;
};

/**
 * Drop a file only if there is an input to drop it on, and say so rather than throwing.
 *
 * Both drops used to call setInputFiles bare, so a page that rendered src/app/error.tsx — which has
 * no file input — spent 30 s waiting and then killed the run with an uncaught TimeoutError. On
 * 2026-09-20 that cost the run after eight passing checks: nothing else ran, no summary line was
 * printed, and the boundary's own reference went unread while three AuthRetryableFetchError digests
 * sat in next start's log. Returning false keeps the run alive so it reports everything else and
 * exits on its own failure count. An early `return` would not do: the summary and process.exit sit
 * AFTER the try/finally, so returning from inside it skips them and the probe exits 0 while failing.
 */
const dropFile = async (p: Page, file: string) => {
  const input = p.locator('input[type=file]').first();
  const there = await input.waitFor({ state: 'attached', timeout: 30000 }).then(() => true).catch(() => false);
  if (!there) return false;
  await input.setInputFiles([file]);
  return true;
};

/** Intake and the issuer lookup both have to finish. Never wait on wording — the step text changes. */
async function settled(p: Page, timeout = 280000) {
  return p.waitForFunction(
    () => !!document.querySelector('[data-verify-busy="false"]')
      && (!!document.querySelector('[data-certificate-card]') || !!document.querySelector('[data-certificate-refused]')),
    undefined, { timeout },
  ).then(() => true).catch(() => false);
}

async function account() {
  const email = `cert-probe+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: 'Cert Probe', agency: 'Cert Probe' } });
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
  const who = await account();
  const browser = await chromium.launch();
  try {
    // ---- 1500px: the whole flow, including the two model-backed drops.
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
    const page = await ctx.newPage();
    await signIn(page, who);

    await page.goto(`${BASE}/app/certificate`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);
    const body = flat(await page.locator('body').innerText());
    check(!/Something went wrong — reload the page/.test(body) && body.length > 60, 'the page renders');
    check(await page.locator('[data-certificate-drop]').count() === 1, 'exactly one drop zone', `${await page.locator('[data-certificate-drop]').count()}`);
    check(/drop certificates here/i.test(body), 'and it asks for certificates, not "any candidate documents"', body.slice(0, 90));

    // Verify's furniture must not be here. These are the parts the owner named. Asserted on the WORDING each
    // panel renders, not on a hook: Unattached's only hook is per-document (data-unattached-doc), so on a page
    // with no orphans it is absent either way and a selector check could never fail.
    check(!/attached to nobody|all documents are attached/i.test(body), 'no "documents attached to nobody" panel');
    check(!/match against a job/i.test(body), 'no job-matching panel');
    check(!/anonymized|client bullets/i.test(body), 'no CV anonymiser steps');

    // ---- 5. the two entry points
    const railHref = await page.locator('nav a[href="/app/certificate"]').first().getAttribute('href').catch(() => null);
    check(railHref === '/app/certificate', 'the rail\'s "Certificate check" opens this page, not Verify', String(railHref));
    await page.goto(`${BASE}/app/today`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);
    // By its TITLE, never by position: Today has two "cand"-toned tool cards (Certificate check and Candidates),
    // so .first() would assert whichever happens to be rendered first and would quietly follow a reorder.
    const todayCert = await page.evaluate(() => {
      const card = [...document.querySelectorAll('a[data-tool-card]')]
        .find((a) => /certificate check/i.test((a as HTMLElement).innerText));
      return card ? card.getAttribute('href') : null;
    });
    check(todayCert === '/app/certificate', 'Today\'s "Check a certificate" opens this page, not Verify', String(todayCert));

    // ---- 2. a real certificate, read and rendered through CertCard
    await page.goto(`${BASE}/app/certificate`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);
    const t0 = Date.now();
    const droppedCert = await dropFile(page, 'fixtures/test-certificate.pdf');
    check(droppedCert, 'the certificate page offers a file input to drop onto',
      droppedCert ? '' : (await boundaryWhy(page)) || 'no input[type=file] on the page');
    const doneCert = droppedCert && await settled(page);
    console.log(`   certificate settled after ${Math.round((Date.now() - t0) / 1000)}s`);
    check(doneCert, 'the certificate is read and the issuer asked, and the page stops working', doneCert ? '' : await boundaryWhy(page));
    const cards = await page.locator('[data-certificate-card]').count();
    check(cards === 1, 'one certificate card is rendered', `${cards} card(s)`);
    const cardText = flat(await page.locator('[data-certificate-card]').first().innerText().catch(() => ''));
    // Case-insensitive on purpose: the CSS uppercases these headings, the DOM text does not.
    check(/what the document says/i.test(cardText), 'the card shows what the document itself says', cardText.slice(0, 110));
    check(/confirmation/i.test(cardText), 'and, separately, how far confirming it got', cardText.slice(0, 160));
    check(/kept in verify/i.test(flat(await page.locator('body').innerText())), 'and the page says where it waits afterwards');
    check(await sideways(page) <= 2, 'nothing scrolls sideways at 1500px', `${await sideways(page)}px`);

    // ---- 4. stored, and attached to nobody
    const { data: docs } = await admin.from('documents').select('id, type, candidate_id, workspace_id').eq('workspace_id', who.workspace);
    const certDocs = (docs ?? []).filter((d: any) => d.type === 'certificate');
    check(certDocs.length === 1, 'the certificate is stored — a check that keeps no evidence cannot be re-read', `${certDocs.length} document(s)`);
    check(certDocs.every((d: any) => d.candidate_id === null), 'and attached to nobody, so Verify can offer it to a candidate later', JSON.stringify(certDocs.map((d: any) => d.candidate_id)));

    // ---- 3. a CV is refused, stored nowhere, and creates nobody
    const before = (await admin.from('candidates').select('id', { count: 'exact', head: true }).eq('workspace_id', who.workspace)).count ?? 0;
    await page.goto(`${BASE}/app/certificate`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);
    const t1 = Date.now();
    const droppedCv = await dropFile(page, 'fixtures/test-cv.pdf');
    check(droppedCv, 'the page still offers a file input for the refusal case',
      droppedCv ? '' : (await boundaryWhy(page)) || 'no input[type=file] on the page');
    const doneCv = droppedCv && await settled(page);
    console.log(`   CV settled after ${Math.round((Date.now() - t1) / 1000)}s`);
    check(doneCv, 'the CV is read and answered', doneCv ? '' : await boundaryWhy(page));
    const refusedText = flat(await page.locator('[data-certificate-refused]').first().innerText().catch(() => ''));
    check(!!refusedText, 'the CV is refused on screen, not quietly accepted', refusedText.slice(0, 140));
    check(/checks certificates only/i.test(refusedText) && /verify/i.test(refusedText), 'and it says where to take it instead', refusedText.slice(0, 160));
    check(await page.locator('[data-certificate-card]').count() === 0, 'no certificate card is rendered for a CV');
    const after = (await admin.from('candidates').select('id', { count: 'exact', head: true }).eq('workspace_id', who.workspace)).count ?? 0;
    check(after === before, 'no candidate was created by the CV — this screen touches nobody', `${before} before, ${after} after`);
    const { data: docsAfter } = await admin.from('documents').select('id, type').eq('workspace_id', who.workspace);
    check((docsAfter ?? []).every((d: any) => d.type === 'certificate'), 'and the CV itself was not stored', JSON.stringify((docsAfter ?? []).map((d: any) => d.type)));

    // ---- 6. Verify is untouched
    await page.goto(`${BASE}/app/verify`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);
    const verifyBody = flat(await page.locator('body').innerText());
    check(/drop any candidate documents here/i.test(verifyBody), 'Verify still takes every kind of document', verifyBody.slice(0, 100));
    check(/CVs, certificates, passport, contract, medical/i.test(verifyBody), 'and still says so on its own drop zone');
    await ctx.close();

    // ---- 7. 390px: the screen a recruiter uses on a yard
    const phone = await browser.newContext({ viewport: { width: 390, height: 850 }, hasTouch: true, isMobile: true });
    const p2 = await phone.newPage();
    await signIn(p2, who);
    await p2.goto(`${BASE}/app/certificate`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(p2);
    const phoneBody = flat(await p2.locator('body').innerText());
    // Both of these failed on 2026-09-18 saying only that they failed. A check that cannot say WHAT it saw
    // is the swallowed-wait defect in another costume: the log could not distinguish an error boundary from
    // an empty render from a bounce to /login, and the difference is the whole diagnosis. So both now carry
    // the URL and the first of the body — and the URL matters most, because an auth transient sends the
    // screen to /login, where a drop zone is legitimately absent and the page is not broken at all.
    const phoneWhere = `at ${p2.url().replace(BASE, '')} · ${phoneBody.slice(0, 120) || '(empty body)'}`;
    check(!/Something went wrong — reload the page/.test(phoneBody), 'the page renders at 390px — no error boundary', phoneWhere);
    check(await p2.locator('[data-certificate-drop]').count() === 1, 'the drop zone is there at 390px', phoneWhere);
    check(await sideways(p2) <= 2, 'nothing scrolls sideways at 390px', `${await sideways(p2)}px`);
    await phone.close();
  } finally {
    await browser.close();
    // In foreign-key order. This probe stores documents (in storage and in the table) and nothing else; the
    // storage objects go with removeProbe's content sweep.
    const mine: string[] = [];
    const { error: docErr } = await admin.from('documents').delete().eq('workspace_id', who.workspace);
    if (docErr) mine.push(`documents: ${docErr.message}`);
    const notGone = await removeProbe(admin, who.uid, who.workspace, null, { clearContent: true });
    const left = [...mine, notGone].filter(Boolean).join('; ');
    console.log(left ? `\ncleanup left something behind: ${left}` : '\nthe probe account, its workspace and everything it stored were removed');
    if (left) failures++;
  }

  console.log(failures ? `\ncertificate probe: ${failures} FAILED` : '\ncertificate probe: all checks passed');
  process.exit(failures ? 1 : 0);
})();
