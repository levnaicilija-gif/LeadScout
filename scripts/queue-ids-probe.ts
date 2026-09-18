/**
 * Today's queue item opens the leads it names — and nothing else.
 *
 *   npx tsx --env-file=.env.local scripts/queue-ids-probe.ts http://localhost:3163
 *
 * The item reads "Read N new leads — <company> first" and names every company in its sub-line. Until
 * 2026-09-17 it was not a link at all on Today or on Home: `it.href` existed and only Yesterday's page
 * ever read it, and that href was a bare /app/radar — the whole unfiltered list. A named eleven was a
 * suggestion to go looking rather than somewhere to arrive.
 *
 * The two halves are different tables on different tabs — won-work LEADS by lead id, hiring-now
 * COMPANIES by company id — so one filtered view cannot hold both; each tab carries its own `ids` and
 * `also` names the other set.
 *
 * What it proves, against seeded rows whose counts are known:
 *   1. the queue item is a link on Today and on Home, and its href carries the ids it names;
 *   2. ?ids= on Won work shows exactly those leads — decoys in the same workspace stay out;
 *   3. the filter is applied in the QUERY, so the banner's count and the table's rows agree;
 *   4. "+N hiring now →" crosses to the other tab, which shows exactly the named companies;
 *   5. "Clear filter — see all N →" returns to the FULL list on each tab, and N is the real total;
 *   6. with no ?ids= both tabs are unchanged — the filter chains nothing;
 *   7. a company marked not_for_us stays out even when named, and the count never claims more than
 *      the table shows;
 *   8. nothing scrolls sideways at 1500px or 390px.
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

/** The company name on each row of the Won work table, in order. */
const wonRows = (p: Page) => p.locator('table.tbl tbody tr').evaluateAll(
  (rows) => rows.map((r) => (r.querySelector('td') as HTMLElement | null)?.innerText?.split('\n')[0]?.trim() ?? ''),
);

async function account() {
  const email = `queue-ids-probe+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: 'Queue Ids Probe', agency: 'Queue Ids Probe' } });
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

  // Seeded in the probe's OWN workspace: a new account gets an empty one, so this is the only data the
  // page can show it. NAMED rows are the ones the queue item would carry; DECOYS are open leads in the
  // same workspace that the filter must leave out — without them a filter that does nothing would pass.
  const NAMED_LEADS = 3;
  const DECOY_LEADS = 2;
  const ALL_LEADS = NAMED_LEADS + DECOY_LEADS;
  const NAMED_COMPANIES = 2;
  const DECOY_COMPANIES = 1;
  const ALL_COMPANIES = NAMED_COMPANIES + DECOY_COMPANIES;
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString();

  const mkCompany = async (label: string) => (await admin.from('companies').insert({
    workspace_id: who.workspace, name: `Queue ${label} ${stamp}`, country: 'DK', employer_type: 'end_client', is_test: true,
  }).select('id, name').single()).data!;

  // Won work: one company carrying every lead keeps the table's first column readable per row.
  const wonCompany = await mkCompany('Won');
  const leadRows = Array.from({ length: ALL_LEADS }, (_, n) => ({
    workspace_id: who.workspace, company_id: wonCompany.id, kind: 'won_work', status: 'new',
    country: 'DK', project_name: `Queue project ${n}`, trades_inferred: ['welder'],
    fit_score: 60 + n, created_at: iso(3), is_test: true,
  }));
  const { data: leads, error: leadErr } = await admin.from('leads').insert(leadRows).select('id, project_name');
  if (leadErr) throw new Error(`seeding leads failed: ${leadErr.message}`);
  const named = (leads ?? []).slice(0, NAMED_LEADS);
  const decoys = (leads ?? []).slice(NAMED_LEADS);
  const namedLeadIds = named.map((l: any) => String(l.id));

  // Hiring now: each company needs its own open posting. source_url is NOT NULL on job_posts (0001)
  // and carries a unique (lead_id, source_url), so every row gets its own — read from the declaration
  // rather than from memory, which is what failed the last probe's first run.
  const hiringCompanies = [];
  for (let i = 0; i < ALL_COMPANIES; i++) hiringCompanies.push(await mkCompany(`Hiring ${i}`));
  const { error: postErr } = await admin.from('job_posts').insert(
    hiringCompanies.map((c, i) => ({
      workspace_id: who.workspace, company_id: c.id, status: 'open',
      role: `Queue welder ${i}`, country: 'DK', trades: ['welder'],
      source_url: `https://example.invalid/queue-ids/${stamp}/${i}`,
      posted_at: iso(2).slice(0, 10), first_seen_at: iso(2), is_test: true,
    })),
  );
  if (postErr) throw new Error(`seeding postings failed: ${postErr.message}`);
  const namedCompanyIds = hiringCompanies.slice(0, NAMED_COMPANIES).map((c) => String(c.id));

  console.log(`seeded in the probe's own workspace: ${ALL_LEADS} won-work leads (${NAMED_LEADS} named, ${DECOY_LEADS} decoys), ${ALL_COMPANIES} hiring companies (${NAMED_COMPANIES} named, ${DECOY_COMPANIES} decoy)\n`);

  const wonUrl = `${BASE}/app/radar?tab=won&ids=${namedLeadIds.join(',')}&also=${namedCompanyIds.join(',')}`;
  const hiringUrl = `${BASE}/app/radar?tab=hiring&ids=${namedCompanyIds.join(',')}&also=${namedLeadIds.join(',')}`;

  const browser = await chromium.launch();
  try {
    for (const [tag, width, height] of [['1500px', 1500, 1100], ['390px', 390, 850]] as const) {
      const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: width < 500 });
      const page = await ctx.newPage();
      await signIn(page, who);
      console.log(`--- ${tag} ---`);

      // 1 — the queue item is a link, on Today and on Home, and it carries ids.
      for (const [screen, path] of [['Today', '/app/today'], ['Home', '/app/home']] as const) {
        await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await hydrated(page);
        const item = page.locator('[data-queue-item]').first();
        const there = await item.count() > 0;
        check(there, `${screen}: the queue item is a link, not plain text`);
        if (there) {
          const href = await item.getAttribute('href') ?? '';
          check(/\/app\/radar\?tab=(won|hiring)&ids=/.test(href), `${screen}: its link carries the ids it names, not a bare /app/radar`, href.slice(0, 110));
        }
      }

      // 2 — Won work, filtered to the named leads only.
      await page.goto(wonUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(page);
      await page.waitForSelector('[data-ids-filter]', { timeout: 30000 }).catch(() => {});
      const banner = flat(await page.locator('[data-ids-filter]').first().innerText().catch(() => ''));
      const rows = await wonRows(page);
      check(rows.length === NAMED_LEADS, `Won work shows exactly the ${NAMED_LEADS} named leads`, `${rows.length} row(s)`);
      // Built from the constants, never typed as a literal: a hardcoded "3 of 5" silently stops testing
      // what it claims the moment the seed changes, the same way an ordinal does.
      check(new RegExp(`Showing ${NAMED_LEADS} of ${ALL_LEADS} open leads`).test(banner),
        'the banner counts the same rows the table shows', banner.slice(0, 120));
      const tableText = await page.locator('table.tbl tbody').innerText().catch(() => '');
      check(decoys.every((d: any) => !tableText.includes(d.project_name)),
        'the decoy leads are not in the filtered table', decoys.map((d: any) => d.project_name).join(', '));
      check(new RegExp(`and ${NAMED_COMPANIES} on the other tab`).test(banner), 'it says how many are on the other tab', banner.slice(0, 160));
      check(await sideways(page) <= 2, `nothing scrolls sideways at ${tag}`, `${await sideways(page)}px`);

      // 2b — the TAB carries the filter too. This is the one control on the page that threaded nothing, so
      // switching tabs from a filtered view landed on the whole list with no banner — the owner hit it on
      // production and the URL was a bare /app/radar?tab=hiring. Clearing is the Clear filter link's job.
      // The ids must SWAP, not carry: lead ids on Won work, company ids on Hiring now, so handing them over
      // unchanged would filter company_id against lead ids and show a filtered view of nothing.
      const tabHref = await page.locator('[data-tab="hiring"]').getAttribute('href') ?? '';
      check(/[?&]ids=/.test(tabHref), 'the Hiring now TAB keeps the filter rather than dropping it', tabHref.slice(0, 120));
      check(namedCompanyIds.every((id) => tabHref.includes(id)), 'and it carries the COMPANY ids, not the lead ids', tabHref.slice(0, 160));
      // The ids segment only — `also` legitimately holds the lead ids, so searching the whole href would
      // always find them and the check could never fail. startsWith() was the same mistake: it only caught a
      // lead id in first position.
      const tabIdsPart = (tabHref.match(/[?&]ids=([^&]*)/)?.[1] ?? '').split(',');
      check(!namedLeadIds.some((id) => tabIdsPart.includes(id)), 'and no lead id is handed to the hiring tab, where it would filter company_id against nothing', tabIdsPart.join(',').slice(0, 90));
      await page.locator('[data-tab="hiring"]').click();
      await page.waitForURL(/tab=hiring/, { timeout: 30000 }).catch(() => {});
      await hydrated(page);
      check(page.url().includes('ids='), 'after the switch the URL still carries ids', page.url().replace(BASE, '').slice(0, 120));
      check(await page.locator('[data-ids-filter]').count() > 0, 'and the filter banner is still there — the filter did not vanish silently');
      const afterTab = await page.locator('[data-row-href]').count();
      check(afterTab === NAMED_COMPANIES, `and it shows the ${NAMED_COMPANIES} named companies, not the whole list`, `${afterTab} row(s)`);
      await page.goto(wonUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(page);

      // 3 — the cross-link to the other half of the same item.
      const also = page.locator('[data-also-link]').first();
      check(await also.count() > 0, 'the filtered view offers the hiring-now half', flat(await also.innerText().catch(() => '')));
      check(new RegExp(`\\+${NAMED_COMPANIES} hiring now`).test(flat(await also.innerText().catch(() => ''))), 'named with its real count');
      await also.click();
      await page.waitForURL(/tab=hiring&ids=/, { timeout: 30000 }).catch(() => {});
      await hydrated(page);
      check(/tab=hiring&ids=/.test(page.url()), 'it crosses to Hiring now carrying the company ids', page.url().replace(BASE, ''));

      // 4 — Hiring now, filtered to the named companies only.
      await page.goto(hiringUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(page);
      const hBanner = flat(await page.locator('[data-ids-filter]').first().innerText().catch(() => ''));
      const hRows = await page.locator('[data-row-href]').count();
      check(hRows === NAMED_COMPANIES, `Hiring now shows exactly the ${NAMED_COMPANIES} named companies`, `${hRows} row(s)`);
      check(new RegExp(`Showing ${NAMED_COMPANIES} companies`).test(hBanner), 'and the banner agrees with the table', hBanner.slice(0, 120));
      const hText = await page.locator('main').innerText().catch(() => '');
      check(!hText.includes(`Queue Hiring 2 ${stamp}`), 'the decoy company is not in the filtered table');
      check(await sideways(page) <= 2, `Hiring now does not scroll sideways at ${tag}`, `${await sideways(page)}px`);

      // 5 — Clear filter returns to the whole list, on each tab.
      for (const [label, url, want, count] of [
        ['Won work', wonUrl, ALL_LEADS, async () => (await wonRows(page)).length],
        ['Hiring now', hiringUrl, ALL_COMPANIES, async () => page.locator('[data-row-href]').count()],
      ] as const) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await hydrated(page);
        const clear = page.locator('[data-clear-since]').first();
        const offer = flat(await clear.innerText().catch(() => ''));
        check(new RegExp(`see all ${want}`).test(offer), `${label}: "Clear filter" offers the real total (${want})`, offer);
        await clear.click();
        await page.waitForURL((u) => !u.href.includes('ids='), { timeout: 30000 }).catch(() => {});
        await hydrated(page);
        check(!page.url().includes('ids='), `${label}: clearing returns to the unfiltered list`, page.url().replace(BASE, ''));
        check(await page.locator('[data-ids-filter]').count() === 0, `${label}: and the filter banner is gone`);
        check(await count() === want, `${label}: the full list is back — all ${want}`, `${await count()} row(s)`);
      }
      await ctx.close();
    }

    // 6 — a named company marked "not for us" stays out, and the count never claims more than it shows.
    // That decision was taken deliberately; naming the company in a queue item must not undo it.
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
    const page = await ctx.newPage();
    await signIn(page, who);
    const { error: rejErr } = await admin.from('companies').update({ hiring_status: 'not_for_us' }).eq('id', namedCompanyIds[0]);
    if (rejErr && !/column|schema cache/i.test(rejErr.message)) throw new Error(`could not mark the company: ${rejErr.message}`);
    if (!rejErr) {
      console.log('\n--- a named company marked "not for us" ---');
      await page.goto(hiringUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(page);
      const left = await page.locator('[data-row-href]').count();
      const b = flat(await page.locator('[data-ids-filter]').first().innerText().catch(() => ''));
      check(left === NAMED_COMPANIES - 1, 'a company marked "not for us" stays out even when the item names it', `${left} row(s)`);
      check(new RegExp(`Showing ${NAMED_COMPANIES - 1} compan`).test(b), 'and the banner counts what is actually on screen, not what the URL asked for', b.slice(0, 120));
      await admin.from('companies').update({ hiring_status: 'new' }).eq('id', namedCompanyIds[0]);
    }

    // 7 — with no ids, both tabs are untouched. The filter must chain nothing: an unconditional .in()
    // here emptied the whole Hiring now tab while this was being written.
    console.log('\n--- unfiltered, the tabs are unchanged ---');
    for (const [label, url, want, count] of [
      ['Won work', `${BASE}/app/radar?tab=won`, ALL_LEADS, async () => (await wonRows(page)).length],
      ['Hiring now', `${BASE}/app/radar?tab=hiring`, ALL_COMPANIES, async () => page.locator('[data-row-href]').count()],
    ] as const) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await hydrated(page);
      check(await count() === want, `${label}: unfiltered still shows everything (${want})`, `${await count()} row(s)`);
      check(await page.locator('[data-ids-filter]').count() === 0, `${label}: and no filter banner is shown`);
    }
    await ctx.close();
  } finally {
    await browser.close();
    // In foreign-key order, and every table this probe seeds. clearTestWorkspace covers candidates and
    // documents — not leads, job_posts or companies — so a probe that seeds those and leaves them
    // strands its own workspace on leads_workspace_id_fkey.
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

  console.log(failures ? `\nqueue ids probe: ${failures} FAILED` : '\nqueue ids probe: all checks passed');
  process.exit(failures ? 1 : 0);
})();
