/**
 * Post-deploy smoke test: sign in, Home, Today, Leads, a Verify upload and the lead drawer,
 * driven through the real UI against whatever is deployed.
 *
 *   npx tsx --env-file=.env.local scripts/smoke.ts https://leadscout-rfbt.vercel.app
 *
 * Uses a throwaway account with a lead and a CV of its own, and deletes everything afterwards.
 * Exits non-zero if any flow fails, so it can gate a deploy rather than merely describe one.
 */
import fs from 'fs';
import { execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { markWorkspaceTest, markTest, removeProbe, followAllForProbe } from '../src/lib/test-data';

const BASE = process.argv[2] ?? 'https://leadscout-rfbt.vercel.app';
const EMAIL = `smoke+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = 'probe-password-0123456789';
const CV = fs.existsSync('fixtures/sandblaster-cv.docx') ? 'fixtures/sandblaster-cv.docx' : null;
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const bodyOf = (page: Page) => page.locator('body').innerText().catch(() => '');

(async () => {
  const { data: created, error } = await admin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
    user_metadata: { name: 'Smoke Test', agency: 'Smoke Test Agency' },
  });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me!.workspace_id as string;
  // Mark everything this run creates before creating it, so a cleanup can never reach a real
  // record even if the scoping below is wrong.
  await markWorkspaceTest(admin, workspace);
  // From 0032 a new account chooses industries before any screen; this probe checks other screens, so it follows all.
  const followProblem = await followAllForProbe(admin, uid);
  if (followProblem) throw new Error(followProblem);

  const { data: co } = await admin.from('companies').insert({ workspace_id: workspace, name: 'Smoke Offshore AS', employer_type: 'end_client', country: 'NO' }).select().single();
  await markTest(admin, 'companies', [co!.id]);
  const { data: lead } = await admin.from('leads').insert({
    workspace_id: workspace, company_id: co!.id, kind: 'won_work', project_name: 'Smoke frame agreement',
    project_location: 'Norwegian Continental Shelf', country: 'NO', trades_inferred: ['welder'],
    fit_score: 75, status: 'new', source_url: 'https://example.invalid/smoke', source_fetched_at: new Date().toISOString(),
  }).select().single();
  // Item 21: the quoted person's address was recovered from the company's own site, so it carries that page as its source.
  // The article is the source of the name (contacts require one); the company's team page is the source of the address.
  const { error: quotedErr } = await admin.from('contacts').insert({
    lead_id: lead!.id, company_id: co!.id, name: 'Smoke Person', title: 'Head of Operations', source_url: 'https://example.invalid/smoke',
    email: 'smoke.person@example.invalid', email_status: 'found', email_source_url: 'https://example.invalid/smoke-our-team', is_test: true,
  });
  if (quotedErr) console.log(`  ...  could not seed the quoted contact: ${quotedErr.message}`);

  // A lead from a contract award notice beside the news lead, so the Leads table has one of each
  // source to tag. The path starts "smoke-": no real TED notice id starts with a word.
  // Item 21: the winner's own site gave a switchboard, a general address and its HR manager — read once for the company.
  const { data: tenderCo } = await admin.from('companies').insert({
    workspace_id: workspace, name: 'Smoke Tender Winner AS', employer_type: 'unknown', country: 'DK', domain: 'example.invalid',
    switchboard: '+45 70 00 00 00', switchboard_source_url: 'https://example.invalid/smoke-contact',
    general_email: 'post@example.invalid', general_email_source_url: 'https://example.invalid/smoke-contact', contacts_checked_at: new Date().toISOString(),
  }).select().single();
  await markTest(admin, 'companies', [tenderCo!.id]);
  const { error: siteContactErr } = await admin.from('contacts').insert({
    company_id: tenderCo!.id, lead_id: null, name: 'Smoke Site Person', title: 'HR Manager',
    email: 'smoke.site@example.invalid', email_status: 'found', email_source_url: 'https://example.invalid/smoke-organisation',
    source_url: 'https://example.invalid/smoke-organisation', is_test: true,
  });
  if (siteContactErr) console.log(`  ...  could not seed the company-site contact: ${siteContactErr.message}`);
  const { data: tenderLead } = await admin.from('leads').insert({
    workspace_id: workspace, company_id: tenderCo!.id, kind: 'won_work', project_name: 'Smoke quay award',
    project_location: 'DNK', country: 'DK', trades_inferred: ['welder'], fit_score: 70, status: 'new',
    source_url: `https://ted.europa.eu/en/notice/-/detail/smoke-${Date.now()}`, source_fetched_at: new Date().toISOString(),
  }).select().single();
  await markTest(admin, 'leads', [lead!.id, tenderLead!.id]);

  // Item 19: a company with two independent signal types today — a tender award whose notice states no date (so it is
  // dated by our first reading) and an open posting — so its lead's fit 60 is boosted ×1.1 to 66, reason on screen.
  const { data: compoundCo } = await admin.from('companies').insert({ workspace_id: workspace, name: 'Smoke Compound AS', employer_type: 'end_client', country: 'NO' }).select().single();
  await markTest(admin, 'companies', [compoundCo!.id]);
  const { data: compoundLead } = await admin.from('leads').insert({
    workspace_id: workspace, company_id: compoundCo!.id, kind: 'won_work', project_name: 'Smoke compound award',
    project_location: 'Bergen', country: 'NO', trades_inferred: ['welder'], fit_score: 60, status: 'new', is_test: true,
    source_url: `https://ted.europa.eu/en/notice/-/detail/smoke-compound-${Date.now()}`, source_fetched_at: new Date().toISOString(),
  }).select().single();
  const { error: compoundJobErr } = await admin.from('job_posts').insert({
    company_id: compoundCo!.id, source_url: `https://example.invalid/smoke-compound-job-${Date.now()}`, title: 'Smoke Compound Welder', role: 'Smoke Compound Welder',
    trades: ['welder'], location: 'Bergen, NO', country: 'NO', status: 'open', via: 'http', is_trade: true, posted_at: new Date().toISOString().slice(0, 10),
    first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), is_test: true,
  });
  if (compoundJobErr) console.log(`  ...  could not seed the compound-signal posting: ${compoundJobErr.message}`);

  // Item 17: the news lead's article is 100 days old — a stale signal. articles has no is_test
  // column, so this row is marked by its example.invalid URL and deleted by id under that URL only.
  const agedOn = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
  const { data: agedArticle, error: agedErr } = await admin.from('articles').insert({
    url: `https://example.invalid/smoke-aged-story-${Date.now()}`, title: 'Smoke aged story',
    text: 'Smoke Offshore AS won the smoke frame agreement.', published_at: agedOn,
  }).select('id').single();
  if (agedErr) console.log(`  ...  could not seed an aged article: ${agedErr.message}`);
  else await admin.from('lead_articles').insert({ lead_id: lead!.id, article_id: agedArticle!.id });

  // Item 17 on Hiring now: a company whose only advert was posted 70 days ago (ageing), and one whose
  // "Smoke Rigger" role was advertised on three days inside 180 — re-advertised twice, so raised.
  const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const { data: agedCo } = await admin.from('companies').insert({ workspace_id: workspace, name: 'Smoke Aged Hiring AS', employer_type: 'end_client', country: 'NO' }).select().single();
  const { data: readvertCo } = await admin.from('companies').insert({ workspace_id: workspace, name: 'Smoke Readvert AS', employer_type: 'end_client', country: 'NO' }).select().single();
  await markTest(admin, 'companies', [agedCo!.id, readvertCo!.id]);
  const agePosting = (companyId: string, role: string, postedAt: string, n: number) => ({
    company_id: companyId, source_url: `https://example.invalid/smoke-age-job-${Date.now()}-${n}`, title: role, role, trades: ['rigger'],
    location: 'Stavanger, NO', country: 'NO', status: 'open', via: 'http', is_trade: true, posted_at: postedAt,
    first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), is_test: true,
  });
  const { error: ageJobErr } = await admin.from('job_posts').insert([
    agePosting(agedCo!.id, 'Smoke Scaffolder', dayAgo(70), 1),
    agePosting(readvertCo!.id, 'Smoke Rigger', dayAgo(100), 2),
    agePosting(readvertCo!.id, 'Smoke Rigger', dayAgo(50), 3),
    agePosting(readvertCo!.id, 'Smoke Rigger', dayAgo(5), 4),
  ]);
  if (ageJobErr) console.log(`  ...  could not seed the aged and re-advertised postings: ${ageJobErr.message}`);

  // A person read off a company's organisation page hangs from the company, not a lead. 0001's
  // contacts policy hid every such row from signed-in users, so Karstensens' drawer showed a
  // switchboard and no name while René Hansen sat in the table. Seed one and look for it on screen.
  const { data: orgCo } = await admin.from('companies').insert({ workspace_id: workspace, name: 'Smoke Org Page AS', employer_type: 'end_client', country: 'NO' }).select().single();
  await markTest(admin, 'companies', [orgCo!.id]);
  await admin.from('job_posts').insert({
    company_id: orgCo!.id, source_url: `https://example.invalid/smoke-org-job-${Date.now()}`,
    title: 'Smoke Fitter', role: 'Smoke Fitter', trades: ['fitter'], location: 'Bergen, NO', country: 'NO', status: 'open', via: 'http',
    is_trade: true, first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), is_test: true,
  });
  const { data: orgContact, error: orgErr } = await admin.from('contacts').insert({
    company_id: orgCo!.id, lead_id: null, name: 'Smoke Orgpage Person', title: 'Production Manager',
    source_url: 'https://example.invalid/smoke-organization', email_status: 'unknown', is_test: true,
  }).select('id').single();
  if (orgErr) console.log(`  ...  could not seed an organisation-page contact: ${orgErr.message}`);

  // A posting anchored on the COMPANY and not on a lead — the shape every careers-page and job
  // board posting has. Hiring now was empty for every user for days because RLS still keyed on
  // lead_id, and nothing here noticed: an RLS denial is an empty result, not an error.
  const { error: jpErr } = await admin.from('job_posts').insert({
    company_id: co!.id, source_url: `https://example.invalid/smoke-job-${Date.now()}`,
    title: 'Smoke Welder', role: 'Smoke Welder', trades: ['welder'],
    location: 'Esbjerg, DK', country: 'DK', status: 'open', via: 'http',
    // Marked like every other seeded row: until 2026-09-14 this one alone was is_test false, so a count of
    // real postings taken while smoke ran included it.
    is_trade: true, first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), is_test: true,
  });
  if (jpErr) console.log(`  ...  could not seed a job posting: ${jpErr.message}`);

  // Against a deployed base, wait until the build serving requests is the commit we mean to
  // test. A run that starts seconds after a push tests the previous build and reports failures
  // against correct code — which sends you hunting a bug that is not there.
  if (!/localhost|127\.0\.0\.1/.test(BASE)) {
    const want = execSync('git rev-parse HEAD').toString().trim();
    const deadline = Date.now() + 240_000;
    let serving = '';
    while (Date.now() < deadline) {
      serving = await fetch(`${BASE}/api/health`, { cache: 'no-store' })
        .then((r) => r.json()).then((j: any) => j?.sha ?? '').catch(() => '');
      if (serving === want) break;
      if (!serving) { console.log('  ...  /api/health has no commit to report — not waiting'); break; }
      console.log(`  ...  waiting for the deploy: serving ${serving.slice(0, 7)}, want ${want.slice(0, 7)}`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
    if (serving && serving !== want) {
      console.log(`\n  STOP  ${BASE} is still serving ${serving.slice(0, 7)}, not ${want.slice(0, 7)}. Nothing was tested.`);
      await admin.auth.admin.deleteUser(uid);
      process.exit(2);
    }
  }

  console.log(`smoke test against ${BASE}\n`);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));

    // 1 — sign in
    // Supabase rate-limits sign-ins per IP, and a day of probe runs trips it. Report what the
    // page actually says and back off, rather than calling the product broken.
    let saidOnPage = '';
    for (let attempt = 1; attempt <= 4 && !/\/app\//.test(page.url()); attempt++) {
      await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.fill('input[type=email]', EMAIL);
      await page.fill('input[type=password]', PASSWORD);
      await page.click('form button:not([type=button])');
      await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});
      if (/\/app\//.test(page.url())) break;
      saidOnPage = await page.evaluate(() => (document.querySelector('.text-bad') as HTMLElement)?.innerText ?? '(no message shown)');
      console.log(`  ...  sign-in attempt ${attempt} did not reach /app — page says: ${saidOnPage}`);
      await page.waitForTimeout(15000 * attempt);
    }
    check(/\/app\//.test(page.url()), 'sign in', page.url().replace(BASE, '') + (saidOnPage ? ` · ${saidOnPage}` : ''));
    // A brand-new account is on onboarding day 1, so it must land on Home. Sign-in used to
    // redirect straight to /app/today, which skipped that decision entirely.
    check(/\/app\/home/.test(page.url()), 'a new user lands on Home', page.url().replace(BASE, ''));

    // 2 — Home
    await page.goto(`${BASE}/app/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Wait for Home's own pill, not a fixed 1.5 s: on 2026-09-14 production answered slowly (the login page
    // took 11 s) and this check failed with nothing to show for it while Home was fine on the next run.
    await page.waitForSelector('[data-pulse="rls"]', { timeout: 60000 }).catch(() => {});
    const home = await bodyOf(page);
    check(/Today, in order/.test(home) && /How this list is made/.test(home), 'Home renders', home.replace(/\s+/g, ' ').slice(0, 200) || 'the page was empty');
    check((await page.locator('input[type=search], input[placeholder*="Search" i]').count()) === 0, 'Home has no search bar');
    // The data access check is on Home for everyone. Never red here: the gate's own sweep has just
    // passed. Amber only while no result is kept (before 0026) or no run has reported in 36 hours.
    const rlsPill = await page.evaluate(() => {
      const p = document.querySelector('[data-pulse="rls"]') as HTMLElement | null;
      return p ? { tone: p.getAttribute('data-tone'), text: p.innerText } : null;
    });
    check(!!rlsPill && rlsPill.tone !== 'bad' && /Data access check/.test(rlsPill.text), 'Home shows the data access check, and it is not red', JSON.stringify(rlsPill));

    // 3 — Today
    await page.goto(`${BASE}/app/today`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1200);
    const today = await bodyOf(page);
    check(!/Application error/.test(today) && today.length > 60, 'Today renders');
    // Item 17: fresh-first. The news lead's article is 100 days old and its fit is higher (75); the
    // award lead has no date (age unknown, fit 70). The award lead is named first, the other labelled.
    check(/Smoke Tender Winner AS first/.test(today) && /Smoke Offshore AS \(stale signal\)/.test(today),
      'Today names an undated lead before a stale signal and labels the stale one', today.match(/Read \d+ new leads?[^\n]*/)?.[0] ?? 'no new-leads item on Today');
    check(/Smoke Readvert AS \(hiring now\)/.test(today), 'Today lists a hiring-now company for a re-advertised role', today.match(/Read \d+ new leads?[^\n]*\n?[^\n]*/)?.[0] ?? 'no new-leads item on Today');
    // Item 19: a new lead whose company has a tender award and an open posting is labelled boosted on Today too.
    check(/Smoke Compound AS \(boosted\)/.test(today), 'item 19: Today labels a lead whose company has two signal types "boosted"', today.match(/Read \d+ new leads?[^\n]*\n?[^\n]*/)?.[0] ?? 'no new-leads item on Today');

    // 4 — Leads
    await page.goto(`${BASE}/app/radar`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Wait for a lead row, not a fixed 1.2 s. On 2026-09-14 production rendered Leads in 1.0–1.6 s and eleven
    // checks failed from this one early read while the screen was fine (checked as a signed-in user straight after).
    await page.waitForSelector('tr[data-lead-source]', { timeout: 60000 }).catch(() => {});
    const leads = await bodyOf(page);
    check(/Smoke Offshore AS/.test(leads), 'Leads lists the seeded lead', /Smoke Offshore AS/.test(leads) ? '' : leads.replace(/\s+/g, ' ').slice(0, 200));
    // Each row carries its source as an attribute and a visible word. Read both off the row that
    // names the company, so the check cannot pass on a tag belonging to some other lead.
    const tags = await page.evaluate(() => Array.from(document.querySelectorAll('tr[data-lead-source]')).map((tr) => ({
      text: (tr as HTMLElement).innerText,
      source: tr.getAttribute('data-lead-source'),
      tag: (tr.querySelector('[data-source]') as HTMLElement | null)?.innerText ?? '',
    })));
    const tenderRow = tags.find((t) => t.text.includes('Smoke Tender Winner AS'));
    const newsRow = tags.find((t) => t.text.includes('Smoke Offshore AS'));
    check(tenderRow?.source === 'tender' && /Tender award/.test(tenderRow.tag), 'a TED-sourced lead is tagged "Tender award"', JSON.stringify(tenderRow ? { source: tenderRow.source, tag: tenderRow.tag } : 'row not found'));
    check(newsRow?.source === 'news' && /News/.test(newsRow.tag), 'a news-sourced lead is tagged "News"', JSON.stringify(newsRow ? { source: newsRow.source, tag: newsRow.tag } : 'row not found'));
    // The chip for the view you are on must look selected. `.chip` sits after the utilities in
    // globals.css, so a plain bg-rail lost to it and "All" rendered white with its count in white.
    const allChip = await page.evaluate(() => {
      const a = document.querySelector('[data-source-filter] a') as HTMLElement | null;
      return a ? { bg: getComputedStyle(a).backgroundColor, text: a.innerText } : null;
    });
    check(allChip?.bg === 'rgb(14, 26, 43)' && /All\s*\d+/.test(allChip.text), 'the "All" chip shows as selected, with its count', JSON.stringify(allChip));
    // Item 17: age on the row. The news lead's article is 100 days old — stale, dimmed, labelled and
    // sorted below the undated award lead despite its higher fit. The award lead: age unknown, not dimmed.
    const ageRows = await page.evaluate(() => Array.from(document.querySelectorAll('tr[data-lead-source]')).map((tr) => ({
      name: (tr as HTMLElement).innerText.split('\n')[0], age: tr.getAttribute('data-age'), opacity: getComputedStyle(tr).opacity,
      label: (tr.querySelector('[data-age-label]') as HTMLElement | null)?.innerText ?? '',
    })));
    const staleAt = ageRows.findIndex((r) => r.name.includes('Smoke Offshore AS'));
    const unknownAt = ageRows.findIndex((r) => r.name.includes('Smoke Tender Winner AS'));
    check(staleAt >= 0 && ageRows[staleAt].age === 'stale' && /stale signal · 100 days/.test(ageRows[staleAt].label) && ageRows[staleAt].opacity === '0.6',
      'a news lead whose article is 100 days old reads "stale signal" and is dimmed', JSON.stringify(ageRows[staleAt] ?? 'row not found'));
    check(unknownAt >= 0 && ageRows[unknownAt].age === 'unknown' && ageRows[unknownAt].label === 'age unknown' && ageRows[unknownAt].opacity === '1',
      'an undated lead says "age unknown" and is not dimmed', JSON.stringify(ageRows[unknownAt] ?? 'row not found'));
    check(unknownAt >= 0 && staleAt > unknownAt, 'the stale lead sorts below the undated one despite a higher fit', `undated at ${unknownAt}, stale at ${staleAt}`);

    // Item 19 on Leads: Smoke Compound AS has a tender award and an open posting today, so its lead reads 66, not 60, and
    // the row names both signals without hover. Smoke Offshore AS (a 100-day story and a posting: one type inside 60
    // days) and Smoke Tender Winner AS (an award only) carry no boost.
    const boostRows = await page.evaluate(() => Array.from(document.querySelectorAll('tr[data-lead-source]')).map((tr) => ({
      name: (tr as HTMLElement).innerText.split('\n')[0],
      boost: (tr.querySelector('[data-compound]') as HTMLElement | null)?.innerText ?? '',
      from: (tr.querySelector('[data-fit-from]') as HTMLElement | null)?.innerText ?? '',
      text: (tr as HTMLElement).innerText.replace(/\s+/g, ' '),
    })));
    const compoundRow = boostRows.find((r) => r.name.includes('Smoke Compound AS'));
    check(!!compoundRow && /boosted ×1\.1: tender award \+ open Hiring now posting/.test(compoundRow.boost) && /boosted, was 60/.test(compoundRow.from) && /\b66\b/.test(compoundRow.text),
      'item 19: a company with a tender award and an open posting shows its lead boosted 60 → 66, the signals named on the row', JSON.stringify(compoundRow ?? 'row not found'));
    const singles = boostRows.filter((r) => /Smoke Offshore AS|Smoke Tender Winner AS/.test(r.name));
    check(singles.length === 2 && singles.every((r) => !r.boost && !r.from), 'item 19: a company with one signal type inside 60 days carries no boost', JSON.stringify(singles));
    await page.goto(`${BASE}/app/radar?lead=${compoundLead!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('aside [data-compound-why]', { timeout: 30000 }).catch(() => {});
    const compoundWhy = await page.locator('aside [data-compound-why]').first().innerText().catch(() => '');
    check(/^Boosted ×1\.1 — 2 independent signals inside 60 days, on the same day: tender award \d{4}-\d{2}-\d{2} \(first read by Radar/.test(compoundWhy)
      && /open Hiring now posting \d{4}-\d{2}-\d{2} \(advert posted\)/.test(compoundWhy) && /Fit 60 → 66\./.test(compoundWhy),
      'item 19: the lead drawer says why the fit was boosted, each signal with its date and what the date is', compoundWhy || 'no reason in the drawer');
    const boostPhone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const m = await boostPhone.newPage();
      await m.goto(`${BASE}/app/radar`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await m.waitForSelector('tr[data-lead-source]', { timeout: 60000 }).catch(() => {});
      const onPhone = await m.evaluate(() => {
        const tr = Array.from(document.querySelectorAll('tr[data-lead-source]')).find((t) => (t as HTMLElement).innerText.includes('Smoke Compound AS'));
        const el = tr?.querySelector('[data-compound]') as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { text: el.innerText, left: Math.round(r.left), right: Math.round(r.right), shown: r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' };
      });
      check(!!onPhone && onPhone.shown && onPhone.left >= 0 && onPhone.right <= 390 && /boosted ×1\.1: tender award \+ open Hiring now posting/.test(onPhone.text),
        'item 19 at 390px, touch: the boost and its signals are on screen without hover', JSON.stringify(onPhone ?? 'no boost on the row'));
    } finally {
      await boostPhone.close();
    }

    // Item 21 on Won work: a tender award names nobody, so its row shows who the winner's own site gave; the drawer shows
    // that person, the switchboard and the general address, each with its page. The news lead's quoted person keeps
    // their place and shows the address recovered from the company site, with that page as its source. A company with
    // no website on file gets prepared searches, said to be searches.
    await page.goto(`${BASE}/app/radar?tab=won`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('tr[data-lead-source]', { timeout: 60000 }).catch(() => {});
    const siteCell = await page.evaluate(() => {
      const tr = Array.from(document.querySelectorAll('tr[data-lead-source]')).find((t) => (t as HTMLElement).innerText.includes('Smoke Tender Winner AS'));
      return (tr?.querySelector('[data-company-contact]') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ') ?? '';
    });
    check(/Smoke Site Person/.test(siteCell) && /HR Manager · from their site · email found/.test(siteCell), 'item 21: a tender award row shows the person the winner\'s own site gave', siteCell || 'no company contact on the row');
    await page.goto(`${BASE}/app/radar?tab=won&lead=${tenderLead!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('aside [data-company-site]', { timeout: 30000 }).catch(() => {});
    const siteBlock = await page.evaluate(() => {
      const el = document.querySelector('aside [data-company-site]') as HTMLElement | null;
      return el ? { text: el.innerText.replace(/\s+/g, ' '), sources: Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href')).filter((h) => h?.startsWith('https://example.invalid/')) } : null;
    });
    check(!!siteBlock && /Smoke Site Person/.test(siteBlock.text) && /smoke\.site@example\.invalid/.test(siteBlock.text) && /Switchboard \+45 70 00 00 00/.test(siteBlock.text) && /General email post@example\.invalid/.test(siteBlock.text) && siteBlock.sources.length >= 3,
      'item 21: the lead drawer shows the company-site person, switchboard and general email, each with its source page', JSON.stringify(siteBlock ?? 'no company-site block'));
    await page.goto(`${BASE}/app/radar?tab=won&lead=${lead!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('aside [data-quoted-email]', { timeout: 30000 }).catch(() => {});
    const quotedEmail = await page.evaluate(() => {
      const aside = document.querySelector('aside') as HTMLElement | null;
      return aside ? { name: /Smoke Person/.test(aside.innerText), email: (aside.querySelector('[data-quoted-email]') as HTMLElement | null)?.innerText ?? '', source: aside.querySelector('[data-quoted-email-source]')?.getAttribute('href') ?? '' } : null;
    });
    check(!!quotedEmail && quotedEmail.name && /smoke\.person@example\.invalid/.test(quotedEmail.email) && quotedEmail.source === 'https://example.invalid/smoke-our-team',
      'item 21: the quoted person stays and shows the address recovered from their company\'s site, with its source', JSON.stringify(quotedEmail));
    await page.goto(`${BASE}/app/radar?tab=won&lead=${compoundLead!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('aside [data-prepared-searches]', { timeout: 30000 }).catch(() => {});
    const searches = await page.evaluate(() => {
      const el = document.querySelector('aside [data-prepared-searches]') as HTMLElement | null;
      return el ? { text: el.innerText.replace(/\s+/g, ' ').slice(0, 160), links: el.querySelectorAll('a').length } : null;
    });
    check(!!searches && /No website on file for this company/.test(searches.text) && /these are searches, not people we found/.test(searches.text) && searches.links === 4,
      'item 21: a company with no website on file gets four prepared searches, labelled as searches', JSON.stringify(searches ?? 'no prepared searches'));
    const sitePhone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const m = await sitePhone.newPage();
      await m.goto(`${BASE}/app/radar?tab=won&lead=${tenderLead!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await m.waitForSelector('aside [data-company-site]', { timeout: 30000 }).catch(() => {});
      const onPhone = await m.evaluate(() => {
        const el = document.querySelector('aside [data-company-site]') as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), person: /Smoke Site Person/.test(el.innerText), wide: document.documentElement.scrollWidth };
      });
      check(!!onPhone && onPhone.person && onPhone.left >= 0 && onPhone.right <= 390 && onPhone.wide <= 390,
        'item 21 at 390px, touch: the company-site block fits the drawer with no sideways scroll', JSON.stringify(onPhone ?? 'no company-site block'));
    } finally {
      await sitePhone.close();
    }
    await page.goto(`${BASE}/app/radar`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('tr[data-lead-source]', { timeout: 60000 }).catch(() => {});

    // "Latest activity" (?sort=latest): Fresh, Ageing, Stale, then Age unknown, newest first within each.
    // The seeded 100-day story is stale and the award has no date, so here the story comes first — the
    // reverse of the Fit sort just checked. The rule is checked row by row, not only for the seeded pair.
    const LATEST_ORDER: Record<string, number> = { fresh: 0, flagged: 1, stale: 2, unknown: 3 };
    const inLatestOrder = (rows: { age: string | null; date: string }[]) => rows.every((r, i) => {
      if (i === 0) return true;
      const p = rows[i - 1];
      const step = LATEST_ORDER[r.age ?? 'unknown'] - LATEST_ORDER[p.age ?? 'unknown'];
      return step > 0 || (step === 0 && (!p.date || !r.date || p.date >= r.date));
    });
    await page.goto(`${BASE}/app/radar?tab=won&sort=latest`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('tr[data-lead-source]', { timeout: 60000 }).catch(() => {});
    const latestRows = await page.evaluate(() => Array.from(document.querySelectorAll('tr[data-lead-source]')).map((tr) => ({
      name: (tr as HTMLElement).innerText.split('\n')[0], age: tr.getAttribute('data-age'), date: tr.getAttribute('data-age-date') ?? '',
    })));
    const latestChip = await page.evaluate(() => {
      const a = document.querySelector('[data-sort-control] a[data-sort="latest"]') as HTMLElement | null;
      return a ? getComputedStyle(a).backgroundColor : null;
    });
    const storyAt = latestRows.findIndex((r) => r.name.includes('Smoke Offshore AS'));
    const awardAt = latestRows.findIndex((r) => r.name.includes('Smoke Tender Winner AS'));
    check(latestChip === 'rgb(14, 26, 43)' && inLatestOrder(latestRows) && storyAt >= 0 && awardAt > storyAt,
      'Leads, Latest activity: fresh, ageing, stale, then age unknown, newest first — the stale story now above the undated award',
      JSON.stringify({ chip: latestChip, rows: latestRows.map((r) => `${r.name}:${r.age}:${r.date || '-'}`) }));
    await page.goto(`${BASE}/app/radar`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('tr[data-lead-source]', { timeout: 60000 }).catch(() => {});
    // A row must say it opens something: a chevron drawn on the row (not only on hover), a hover
    // tint, and a click on a plain cell — not the company link — opens the drawer. The Trades cell
    // (the fourth) holds no link on either table.
    // A row or "?" is server-rendered before its handler exists, and a tap in that gap does nothing: Leads
    // at 390px failed on production twice that way on 2026-09-14. Wait for the page to be interactive.
    const hydrated = (p: typeof page) => p.waitForSelector('html[data-hydrated="true"]', { state: 'attached', timeout: 60000 }).catch(() => {});
    const rowOpens = async (rowText: string, param: RegExp, what: string) => {
      await hydrated(page);
      const row = page.locator('tr[data-row-href]', { hasText: rowText }).first();
      const cell = row.locator('td').nth(3);
      const chevron = await row.locator('[data-row-open]').isVisible().catch(() => false);
      const before = await cell.evaluate((td) => getComputedStyle(td).backgroundColor).catch(() => '');
      await cell.hover({ position: { x: 4, y: 4 } }).catch(() => {});
      const after = await cell.evaluate((td) => getComputedStyle(td).backgroundColor).catch(() => '');
      await cell.click({ position: { x: 4, y: 4 } }).catch(() => {});
      await page.waitForURL(param, { timeout: 30000 }).catch(() => {});
      const drawer = await page.locator('aside').first().isVisible().catch(() => false);
      // The designed tint (#F2F6FC), not merely "changed": the old near-white hover also changed.
      check(chevron && after === 'rgb(242, 246, 252)' && before !== after && param.test(page.url()) && drawer, `${what}: chevron on the row, hover tint, a click on a plain cell opens the drawer`, JSON.stringify({ chevron, before, after, url: page.url().replace(BASE, ''), drawer }));
    };
    await rowOpens('Smoke Offshore AS', /[?&]lead=/, 'Leads row');
    await page.goto(`${BASE}/app/radar`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // The "?" beside each table says what the drawer holds. Opening it must show that text.
    const drawerHelp = async (p: typeof page, title: string, what: string, width?: number) => {
      const btn = p.locator('[data-drawer-help] button').first();
      await btn.waitFor({ timeout: 30000 }).catch(() => {});
      await hydrated(p);
      const box = await btn.boundingBox().catch(() => null);
      const onScreen = !!box && box.width > 0 && (!width || (box.x >= 0 && box.x + box.width <= width));
      if (width) await btn.tap().catch(() => {}); else await btn.click().catch(() => {});
      const text = await p.locator('[data-drawer-help]').first().innerText().catch(() => '');
      const shown = text.includes(title) && /four tools/.test(text);
      check(onScreen && shown, `${what}: the "?" beside the table explains the drawer`, JSON.stringify({ onScreen, shown, text: text.replace(/\s+/g, ' ').slice(0, 90) }));
    };
    await drawerHelp(page, 'What opens when you click a lead', 'Leads');
    // The source filter narrows the table to one kind, and the other kind is gone from it.
    await page.goto(`${BASE}/app/radar?tab=won&source=tender`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('tr[data-lead-source]', { timeout: 60000 }).catch(() => {});
    const onlyTender = await page.evaluate(() => Array.from(document.querySelectorAll('tr[data-lead-source]')).map((tr) => ({ source: tr.getAttribute('data-lead-source'), text: (tr as HTMLElement).innerText })));
    check(onlyTender.some((r) => r.text.includes('Smoke Tender Winner AS')) && onlyTender.every((r) => r.source === 'tender'), '?source=tender shows only award-notice leads', `${onlyTender.length} rows, kinds: ${[...new Set(onlyTender.map((r) => r.source))].join(',')}`);
    // Item 18 part 1: Won work's country chips come from the leads' own countries (the news lead is NO, the award
    // lead DK), and ?country= narrows the table to one while the other stays offered.
    await page.goto(`${BASE}/app/radar?tab=won&country=DK`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('tr[data-lead-source]', { timeout: 60000 }).catch(() => {});
    const countryChips = await page.$$eval('[data-country-filter] [data-country]', (els) => els.map((e) => ({ c: e.getAttribute('data-country'), on: e.className.includes('!bg-rail') })));
    const dkRows = await page.$$eval('tr[data-lead-source]', (trs) => trs.map((t) => (t as HTMLElement).innerText.split('\n')[0]));
    const rowLinksKeepCountry = await page.$$eval('tr[data-row-href]', (trs) => trs.every((t) => /[?&]country=DK/.test(t.getAttribute('data-row-href') ?? '')));
    check(countryChips.some((x) => x.c === 'DK' && x.on) && countryChips.some((x) => x.c === 'NO' && !x.on)
      && dkRows.some((r) => r.includes('Smoke Tender Winner AS')) && !dkRows.some((r) => r.includes('Smoke Offshore AS')) && rowLinksKeepCountry,
      '?country=DK shows only the Danish lead, DK is selected, NO is still offered, and opening a row keeps the filter',
      JSON.stringify({ chips: countryChips, rows: dkRows, rowLinksKeepCountry }));

    // 4b — Hiring now must show the company-anchored posting. This is the check that was
    // missing when Hiring now sat empty over forty real rows.
    await page.goto(`${BASE}/app/radar?tab=hiring`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // A company row, not a fixed 1.5 s — the same early read that failed Home and Leads on 2026-09-14.
    await page.waitForSelector('tr[data-row-href]', { timeout: 60000 }).catch(() => {});
    const hiring = await bodyOf(page);
    check(/Smoke Welder/.test(hiring), 'Hiring now lists a company-anchored posting');
    // Any empty state at all is a failure here: one posting was seeded for this workspace, so
    // the table has something to show. The message varies, so match the shapes it can take.
    check(!/No trade postings open|No careers pages found yet|Nothing from an employer/.test(hiring),
      'Hiring now shows the table rather than an empty state');
    // Item 17 on Hiring now: the re-advertised company is raised to the top and badged; the company
    // whose only advert is 70 days old reads "ageing", is dimmed and sorts last; one first seen today is fresh.
    const hiringRows = await page.evaluate(() => Array.from(document.querySelectorAll('tr[data-row-href]')).map((tr) => ({
      name: (tr as HTMLElement).innerText.split('\n')[0], age: tr.getAttribute('data-age'), boosted: tr.getAttribute('data-boosted') === 'true',
      opacity: getComputedStyle(tr).opacity, label: (tr.querySelector('[data-age-label]') as HTMLElement | null)?.innerText ?? '',
      badge: (tr.querySelector('[data-boosted-label]') as HTMLElement | null)?.innerText ?? '',
    })));
    const rowAt = (n: string) => hiringRows.findIndex((r) => r.name.includes(n));
    const raisedRow = hiringRows[rowAt('Smoke Readvert AS')];
    check(rowAt('Smoke Readvert AS') === 0 && !!raisedRow?.boosted && /re-advertised 2× — priority raised/.test(raisedRow.badge) && raisedRow.opacity === '1',
      'a role advertised on three days inside 180 is raised to the top and badged', JSON.stringify({ index: rowAt('Smoke Readvert AS'), row: raisedRow ?? 'not found' }));
    const agedRow = hiringRows[rowAt('Smoke Aged Hiring AS')];
    check(agedRow?.age === 'flagged' && /ageing · 70 days/.test(agedRow.label) && agedRow.opacity === '0.8' && rowAt('Smoke Aged Hiring AS') === hiringRows.length - 1,
      'a company whose newest advert is 70 days old reads "ageing", is dimmed and sorts last', JSON.stringify({ index: rowAt('Smoke Aged Hiring AS'), of: hiringRows.length, row: agedRow ?? 'not found' }));
    const freshRow = hiringRows[rowAt('Smoke Offshore AS')];
    check(freshRow?.age === 'fresh' && freshRow.opacity === '1' && /0 days old/.test(freshRow.label), 'a company first seen today is fresh and not dimmed', JSON.stringify(freshRow ?? 'not found'));

    // Item 19 on Hiring now: Smoke Compound AS has one advert (low pressure) and a tender award today, so its pressure goes
    // one step up to medium with the signals named on the row. Smoke Readvert AS re-advertised a role twice and has nothing
    // else — a repost is the same signal as its advert (owner's decision, 2026-09-15), so it is not boosted.
    const pressureRows = await page.evaluate(() => Array.from(document.querySelectorAll('tr[data-row-href]')).map((tr) => ({
      name: (tr as HTMLElement).innerText.split('\n')[0],
      boost: (tr.querySelector('[data-compound]') as HTMLElement | null)?.innerText ?? '',
      pressure: (tr.querySelector('[data-pressure]') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim() ?? '',
    })));
    const liftedRow = pressureRows.find((r) => r.name.includes('Smoke Compound AS'));
    check(!!liftedRow && /boosted ×1\.1: tender award \+ open Hiring now posting/.test(liftedRow.boost) && /^medium boosted, was low/.test(liftedRow.pressure),
      'item 19: Hiring now lifts pressure one step, low → medium, with the signals named on the row', JSON.stringify(liftedRow ?? 'row not found'));
    const repostOnly = pressureRows.find((r) => r.name.includes('Smoke Readvert AS'));
    check(!!repostOnly && !repostOnly.boost && !/boosted, was/.test(repostOnly.pressure),
      'item 19: a company that only re-advertised its own role is not boosted — a repost is the same signal as its advert', JSON.stringify(repostOnly ?? 'row not found'));
    await page.goto(`${BASE}/app/radar?tab=hiring&company=${compoundCo!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('aside [data-compound-why]', { timeout: 30000 }).catch(() => {});
    const liftedWhy = await page.locator('aside [data-compound-why]').first().innerText().catch(() => '');
    check(/^Boosted ×1\.1 — 2 independent signals inside 60 days, on the same day: tender award \d{4}-\d{2}-\d{2} \(first read by Radar — the notice states no date\); open Hiring now posting \d{4}-\d{2}-\d{2} \(advert posted\)\. Pressure low → medium\.$/.test(liftedWhy),
      'item 19: the Hiring now drawer says why pressure was lifted, each signal with its date', liftedWhy || 'no reason in the drawer');
    const liftPhone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const m = await liftPhone.newPage();
      await m.goto(`${BASE}/app/radar?tab=hiring`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await m.waitForSelector('tr[data-row-href]', { timeout: 60000 }).catch(() => {});
      const onPhone = await m.evaluate(() => {
        const tr = Array.from(document.querySelectorAll('tr[data-row-href]')).find((t) => (t as HTMLElement).innerText.includes('Smoke Compound AS'));
        const el = tr?.querySelector('[data-compound]') as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { text: el.innerText, left: Math.round(r.left), right: Math.round(r.right), shown: r.width > 0 && r.height > 0 };
      });
      check(!!onPhone && onPhone.shown && onPhone.left >= 0 && onPhone.right <= 390 && /boosted ×1\.1: tender award \+ open Hiring now posting/.test(onPhone.text),
        'item 19 at 390px, touch: the Hiring now row shows the boost and its signals without hover', JSON.stringify(onPhone ?? 'no boost on the row'));
    } finally {
      await liftPhone.close();
    }

    // Hiring now, Latest activity: the re-advertised company keeps first place whatever the sort, the rest
    // follow the same state-then-date rule (the 70-day company last), and the agencies toggle keeps the sort.
    await page.goto(`${BASE}/app/radar?tab=hiring&sort=latest`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('tr[data-row-href]', { timeout: 60000 }).catch(() => {});
    const hiringLatest = await page.evaluate(() => Array.from(document.querySelectorAll('tr[data-row-href]')).map((tr) => ({
      name: (tr as HTMLElement).innerText.split('\n')[0], age: tr.getAttribute('data-age'), date: tr.getAttribute('data-age-date') ?? '',
      boosted: tr.getAttribute('data-boosted') === 'true',
    })));
    const toggleKeepsSort = await page.evaluate(() => {
      const toggle = Array.from(document.querySelectorAll('a')).find((a) => /Show agencies/.test(a.textContent ?? '')) as HTMLAnchorElement | undefined;
      return /[?&]sort=latest/.test(toggle?.href ?? '');
    });
    const agedLast = hiringLatest.findIndex((r) => r.name.includes('Smoke Aged Hiring AS')) === hiringLatest.length - 1;
    check(!!hiringLatest[0]?.name.includes('Smoke Readvert AS') && hiringLatest[0].boosted && inLatestOrder(hiringLatest.filter((r) => !r.boosted)) && agedLast && toggleKeepsSort,
      'Hiring now, Latest activity: re-advertised first, then fresh before ageing, newest first; the agencies toggle keeps the sort',
      JSON.stringify({ toggleKeepsSort, rows: hiringLatest.map((r) => `${r.name}:${r.boosted ? 'raised' : r.age}:${r.date || '-'}`) }));
    await page.goto(`${BASE}/app/radar?tab=hiring`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('tr[data-row-href]', { timeout: 60000 }).catch(() => {});
    await drawerHelp(page, 'What opens when you click a company', 'Hiring now');
    await rowOpens('Smoke Offshore AS', /[?&]company=/, 'Hiring now row');

    // The same at 390px on a touch screen. There is no hover there, so the chevron must already be
    // on screen inside the first column, and a tap on the row must open the drawer.
    const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const m = await phone.newPage();
      for (const [path, param, what] of [['/app/radar', /[?&]lead=/, 'Leads row'], ['/app/radar?tab=hiring', /[?&]company=/, 'Hiring now row']] as const) {
        await m.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await m.waitForSelector('tr[data-row-href]', { timeout: 60000 }).catch(() => {});
        await drawerHelp(m, what === 'Leads row' ? 'What opens when you click a lead' : 'What opens when you click a company', `${what.replace(' row', '')} at 390px, touch`, 390);
        const row = m.locator('tr[data-row-href]', { hasText: 'Smoke Offshore AS' }).first();
        const box = await row.locator('[data-row-open]').boundingBox().catch(() => null);
        const onScreen = !!box && box.width > 0 && box.x >= 0 && box.x + box.width <= 390;
        await row.locator('td').nth(3).tap({ position: { x: 4, y: 4 } }).catch(() => {});
        await m.waitForURL(param, { timeout: 30000 }).catch(() => {});
        const drawer = await m.locator('aside').first().isVisible().catch(() => false);
        check(onScreen && param.test(m.url()) && drawer, `${what} at 390px, touch: chevron on screen without hover, a tap opens the drawer`, JSON.stringify({ chevron: box && { x: Math.round(box.x), w: Math.round(box.width) }, url: m.url().replace(BASE, ''), drawer }));
      }
    } finally {
      await phone.close();
    }

    // 4c — the Hiring now drawer. A row a recruiter cannot open is a table, not a screen.
    await page.goto(`${BASE}/app/radar?tab=hiring&company=${co!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Wait for the contact sheet to settle rather than sleeping at it. The sheet is fetched
    // after the drawer paints, so a fixed pause makes these checks turn on timing — and a
    // check that passes or fails on timing is worse than no check, because it teaches you to
    // ignore a red.
    await page.waitForFunction(
      () => { const a = document.querySelector('aside'); return !!a && !a.innerText.includes('Reading what we hold'); },
      undefined, { timeout: 60000 },
    ).catch(() => {});
    const hd = await page.locator('aside').first().innerText().catch(() => '');
    check(/Smoke Offshore AS/.test(hd), 'Hiring now drawer opens on the company');
    check(/Who to contact/.test(hd), 'drawer shows the contact block');
    check(/What they are hiring for/.test(hd) && /Smoke Welder/.test(hd), 'drawer lists the postings');
    // The person a story quoted about this company is a contact for its Hiring now row too, with the address their
    // company's own site gave (item 21). Until 2026-09-15 that seed had no source and never existed, so this drawer
    // showed searches; the searches are checked on a company with nobody on file instead.
    check(/Smoke Person/.test(hd) && /smoke\.person@example\.invalid/.test(hd), 'the Hiring now drawer shows the person quoted about the company, with the address found on its site', hd.replace(/\s+/g, ' ').slice(0, 200));
    await page.goto(`${BASE}/app/radar?tab=hiring&company=${readvertCo!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => { const a = document.querySelector('aside'); return !!a && !a.innerText.includes('Reading what we hold'); },
      undefined, { timeout: 60000 },
    ).catch(() => {});
    const nobodyDrawer = await page.locator('aside').first().innerText().catch(() => '');
    // Nobody was seeded with a contact at this company, so the honest answer is searches — never a made-up name.
    check(/searches to run/.test(nobodyDrawer), 'drawer offers searches when nobody was found', nobodyDrawer.replace(/\s+/g, ' ').slice(0, 200));

    // 4d — a contact on the company alone, as the organisation-page pass stores them.
    await page.goto(`${BASE}/app/radar?tab=hiring&company=${orgCo!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => { const a = document.querySelector('aside'); return !!a && !a.innerText.includes('Reading what we hold'); },
      undefined, { timeout: 60000 },
    ).catch(() => {});
    const orgDrawer = await page.locator('aside').first().innerText().catch(() => '');
    check(/Smoke Orgpage Person/.test(orgDrawer) && /Production Manager/.test(orgDrawer), 'an organisation-page contact on the company is shown to a signed-in user', /Smoke Orgpage Person/.test(orgDrawer) ? '' : orgDrawer.replace(/\s+/g, ' ').slice(0, 200));

    // The RLS sweep as the nightly cron runs it, while this run's own test workspace holds rows: the
    // route answers behind the cron secret, and no table reads less for a signed-in user than it should.
    // ?record=0 keeps a test run out of the history Home shows.
    const sweepRes = await fetch(`${BASE}/api/jobs/rls-sweep?record=0`, { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET ?? '' } })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }))
      .catch((e) => ({ status: 0, body: { error: String(e) } as any }));
    // cleanupError must be empty too. On 2026-09-14 this check passed while the sweep's own delete had failed,
    // leaving its throwaway account inside the real workspace as a senior until it was removed by hand.
    check(sweepRes.status === 200 && sweepRes.body?.ok === true && (sweepRes.body?.tables ?? 0) > 20 && sweepRes.body?.cleanupError == null,
      'the nightly RLS sweep runs behind the cron secret, finds no hidden table and removes its own account',
      JSON.stringify({ status: sweepRes.status, tables: sweepRes.body?.tables, cleanupError: sweepRes.body?.cleanupError ?? null, summary: sweepRes.body?.summary ?? sweepRes.body?.error }));

    // Item 17: each advert in the Hiring now drawer says how old it is and from which date.
    const agedNav = await page.goto(`${BASE}/app/radar?tab=hiring&company=${agedCo!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      .then(async (r) => {
        // On 2026-09-14 this landed on /login mid-session. Say which hop sent it there and why the middleware did.
        const hops: string[] = [];
        for (let q = r?.request().redirectedFrom(); q; q = q.redirectedFrom()) {
          const h = await q.response().then((x) => x && `${x.status()} ${x.headers()['x-signin-reason'] ?? 'no reason header (the page, not the middleware)'}`).catch(() => null);
          if (h) hops.push(h);
        }
        return `HTTP ${r?.status() ?? '—'}${hops.length ? ` after redirect ${hops.join(' ← ')}` : ''}`;
      }, (e) => `navigation failed: ${String(e?.message ?? e).split('\n')[0].slice(0, 120)}`);
    // Wait for the drawer to finish reading, as 4d does, then look. This check failed intermittently on
    // 2026-09-14, first with only "no age line" and then "no drawer on the page"; a failure now also says where the
    // page actually was and what it said, so a redirect, a slow render and a missing company read differently.
    await page.waitForFunction(
      () => { const a = document.querySelector('aside'); return !!a && !a.innerText.includes('Reading what we hold'); },
      undefined, { timeout: 60000 },
    ).catch(() => {});
    await page.waitForSelector('aside [data-age]', { timeout: 30000 }).catch(() => {});
    const advertAge = await page.locator('aside [data-age]').first().innerText().catch(() => '');
    const agedDrawer = advertAge ? '' : await page.locator('aside').first().innerText().catch(() => 'no drawer on the page');
    const agedWhere = advertAge ? '' : await page.evaluate(() => ({
      url: location.pathname + location.search,
      heading: (document.querySelector('h1') as HTMLElement | null)?.innerText ?? '',
      text: (document.querySelector('main') ?? document.body)?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 200) ?? '',
    })).then((w) => ` · ${agedNav} · at ${w.url} · heading "${w.heading}" · page: ${w.text}`, () => ` · ${agedNav} · the page could not be read`);
    check(/ageing · 70 days · posted \d{4}-\d{2}-\d{2}/.test(advertAge), 'the Hiring now drawer dates each advert and marks an ageing one', advertAge || `no age line; the drawer read: ${agedDrawer.replace(/\s+/g, ' ').slice(0, 300)}${agedWhere}`);

    // 5 — lead drawer: one tool, end to end
    await page.goto(`${BASE}/app/radar?lead=${lead!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    check(await page.locator('aside').first().isVisible().catch(() => false), 'lead drawer opens');
    const ageLine = await page.locator('aside [data-age]').first().innerText().catch(() => '');
    check(/stale signal · 100 days — Article published \d{4}-\d{2}-\d{2}, 100 days ago/.test(ageLine), 'lead drawer states the age and the date it is measured from', ageLine || 'no age line');
    const jd = page.locator('aside button.btn-primary:has-text("Write JD")').first();
    if (await jd.count()) {
      await jd.click();
      await page.waitForFunction(() => !document.body.innerText.includes('Writing…'), undefined, { timeout: 75000 }).catch(() => {});
      const drawer = await page.locator('aside').first().innerText();
      check(!drawer.includes('Writing…'), 'drawer never stuck on "Writing…"');
      // Structural, not textual. This used to match on "Job Title|Positions|Responsibilities",
      // which asserts the wording of model output: a perfectly good job description that opened
      // differently failed the check and sent you looking for a bug in the drawer. What matters
      // is that the drawer answered — a result block with something in it, or a stated failure.
      const answered = await page.evaluate(() => {
        const a = document.querySelector('aside');
        if (!a) return { body: 0, error: false };
        // The result carries data-result, so this asks "did the drawer answer" without
        // depending on which element it answered in or what the model chose to write.
        const res = Array.from(a.querySelectorAll('[data-result]')).map((p) => p.textContent ?? '').join('');
        const error = !!a.querySelector('.text-bad');
        return { body: res.trim().length, error };
      });
      check(answered.body > 60 || answered.error, 'drawer shows a result or a plain error',
        answered.body > 60 || answered.error ? '' : `no result block and no error in the drawer (${answered.body} chars)`);
    } else check(false, 'drawer Write JD button present');

    // 6 — Verify upload
    if (!CV) { console.log('  SKIP  Verify upload — fixtures/sandblaster-cv.docx not present'); }
    else {
      await page.goto(`${BASE}/app/verify`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500);
      // A deploy swapping mid-run can serve a page without the input for a moment; one
      // reload distinguishes that from the page genuinely being broken.
      const fileInput = page.locator('input[type=file]').first();
      if (!(await fileInput.count())) { await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3000); }
      // Keep intake's own answer. On 2026-09-14 production never showed "recognised and handled" and this
      // check printed nothing at all — no status, no error text — so a failed intake and a hung one looked alike.
      let intakeAnswer = 'no response from /api/verify/intake';
      const onIntake = async (r: any) => {
        if (!/\/api\/verify\/intake/.test(r.url())) return;
        const body = await r.text().catch(() => '(unreadable)');
        intakeAnswer = `HTTP ${r.status()} · ${body.replace(/\s+/g, ' ').slice(0, 200)}`;
      };
      page.on('response', onIntake);
      await page.locator('input[type=file]').first().setInputFiles([CV]).catch(async (e) => { check(false, 'Verify drop zone present', String(e?.message ?? e).slice(0, 80)); throw e; });
      await page.waitForFunction(
        () => /recognised and handled/.test(document.body.innerText) && !!document.querySelector('[data-verify-busy="false"]'),
        undefined, { timeout: 280000 },
      ).catch(() => {});
      page.off('response', onIntake);
      const verify = await bodyOf(page);
      const verifyState = await page.evaluate(() => ({
        busy: document.querySelector('[data-verify-busy]')?.textContent ?? '',
        // b.text-bad is the page's error line; plain .text-bad also matched the "Internal PDF" button.
        error: Array.from(document.querySelectorAll('main b.text-bad, main details pre')).map((e) => e.textContent ?? '').join(' | '),
      })).catch(() => ({ busy: '', error: '' }));
      check(/recognised and handled/.test(verify), 'Verify accepts and handles an upload',
        /recognised and handled/.test(verify) ? '' : `intake: ${intakeAnswer} · progress line: "${verifyState.busy}"${verifyState.error ? ` · on screen: ${verifyState.error.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
      check(!/could not be prepared/.test(verify), 'Verify prepared the client version');
    }

    // 7 — Candidates must list the candidate the upload just created.
    //
    // This is the check that was missing when 0013 added candidates.eu_passport_document_id and
    // candidates.uk_right_to_work_document_id: a third relationship between candidates and
    // documents made every embed between them ambiguous, PostgREST failed the whole query, and
    // the page reported an empty pool it had never actually read. So assert both halves — that
    // a candidate is listed, and that neither the empty state nor the fault banner is showing.
    // Whether the upload actually produced a candidate is a question for the database, not for
    // the page: if intake failed, "No candidates yet" is the correct thing for Candidates to
    // show, and asserting a row is there turns an upstream flake into a false failure on a
    // screen that is behaving. The service-role query decides whether the assertion applies;
    // the screen is still what answers it.
    const { data: made } = await admin.from('candidates').select('reference_code').eq('workspace_id', workspace);
    const expected = (made ?? []).length;
    if (CV && expected === 0) {
      console.log('  ...  the Verify upload produced no candidate this run — the listing check does not apply');
    }
    if (CV && expected > 0) {
      // Wait for the row rather than sleeping at it: the save that Verify does can land a
      // moment after the upload reports done, and a fixed pause turned this into a check that
      // passed or failed on timing — which is worse than no check, because it teaches you to
      // ignore it. Poll with a reload, since the page is server-rendered.
      const listed = /RFBT-[A-Z]-[0-9]{4}/;
      let pool = '';
      for (let i = 0; i < 6; i++) {
        await page.goto(`${BASE}/app/candidates`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(1200);
        pool = await bodyOf(page);
        if (listed.test(pool) || /could not be read/.test(pool)) break;
      }
      // The page puts the database's own error in a collapsed "Technical detail". Print it on a failure:
      // on 2026-09-14 production reported a query fault here, and the line cut off before it, so nobody
      // could tell a passing Supabase outage from a broken query.
      // textContent, not innerText: the detail sits inside a closed <details>, and innerText of hidden text is empty.
      const faultDetail = await page.evaluate(() => document.querySelector('main details pre')?.textContent ?? '').catch(() => '');
      const faultSuffix = faultDetail ? ` · technical detail: ${faultDetail.replace(/\s+/g, ' ').slice(0, 300)}` : '';
      check(listed.test(pool), 'Candidates lists the candidate the upload created',
        listed.test(pool) ? '' : `${pool.replace(/\s+/g, ' ').slice(0, 300)}${faultSuffix}`);
      check(!/No candidates yet/.test(pool), `Candidates shows the pool rather than an empty state (${expected} in the database)`);
      check(!/could not be read|could not read the pool/.test(pool), 'Candidates read the pool without a query fault', faultSuffix.replace(/^ · /, ''));
    }

    check(pageErrors.length === 0, 'no uncaught client errors', pageErrors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    const { data: cands } = await admin.from('candidates').select('id').eq('workspace_id', workspace);
    for (const c of cands ?? []) await admin.from('candidates').delete().eq('id', c.id);
    await admin.from('documents').delete().eq('workspace_id', workspace);
    await admin.from('job_posts').delete().eq('company_id', co!.id);
    if (orgContact) await admin.from('contacts').delete().eq('id', orgContact.id).eq('is_test', true);
    if (orgCo) { await admin.from('job_posts').delete().eq('company_id', orgCo.id).eq('is_test', true); await admin.from('companies').delete().eq('id', orgCo.id).eq('is_test', true); }
    await admin.from('outreach').delete().eq('lead_id', lead!.id);
    await admin.from('contacts').delete().eq('lead_id', lead!.id);
    await admin.from('scores').delete().eq('lead_id', lead!.id);
    await admin.from('leads').delete().eq('id', lead!.id);
    if (tenderLead) await admin.from('leads').delete().eq('id', tenderLead.id).eq('is_test', true);
    // After the lead, whose delete removes the lead_articles link; the URL guard keeps this off real articles.
    if (agedArticle) await admin.from('articles').delete().eq('id', agedArticle.id).like('url', 'https://example.invalid/%');
    for (const c of [agedCo, readvertCo]) {
      if (!c) continue;
      await admin.from('job_posts').delete().eq('company_id', c.id).eq('is_test', true);
      await admin.from('companies').delete().eq('id', c.id).eq('is_test', true);
    }
    await admin.from('companies').delete().eq('id', co!.id);
    if (tenderCo) {
      await admin.from('contacts').delete().eq('company_id', tenderCo.id).eq('is_test', true);
      await admin.from('companies').delete().eq('id', tenderCo.id).eq('is_test', true);
    }
    // Item 19's company: its lead, then its posting, then the company. Left out on 2026-09-15, the company held the
    // workspace and the gate failed on cleanup with every item 19 check passing.
    if (compoundLead) await admin.from('leads').delete().eq('id', compoundLead.id).eq('is_test', true);
    if (compoundCo) {
      await admin.from('job_posts').delete().eq('company_id', compoundCo.id).eq('is_test', true);
      await admin.from('companies').delete().eq('id', compoundCo.id).eq('is_test', true);
    }
    // Both deletes are read. An ignored delete is how an empty test workspace sat in the real database
    // with nothing said (design-shots, 2026-09-13); a leftover now fails this run.
    const leftBehind = await removeProbe(admin, uid, workspace, null, { clearContent: true });
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); }
    else console.log('\ncleaned up the probe user, its workspace and everything it created');
  }
  console.log(failures === 0 ? 'smoke: all flows passed' : `smoke: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
