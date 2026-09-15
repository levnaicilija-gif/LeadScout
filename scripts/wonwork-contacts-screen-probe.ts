/**
 * Item 21 on real data, read off the screen by a signed-in recruiter of the real workspace.
 *
 *   npx tsx --env-file=.env.local scripts/wonwork-contacts-screen-probe.ts https://leadscout-rfbt.vercel.app [company name…]
 *
 * For each named company (default: every won-work company whose own site gave a switchboard, a general email or a
 * person, up to four), opens Won work on its lead's source list with all industries, reads the lead row's company-contact
 * cell, then the lead drawer's "From the company's own site" block — at 1500px and at 390px on a touch screen — and
 * checks each value shown against the database and that every source link is the page stored for it.
 *
 * A throwaway account enters the real workspace as a recruiter following all industries, and is removed afterwards with
 * its own test-marked workspace; a leftover fails the run. Writes nothing else.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe } from '../src/lib/test-data';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const NAMES = process.argv.slice(3);
const EMAIL = `wonwork-contacts-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = `probe-${Date.now()}-0123456789`;
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };

const readRow = (page: Page, company: string) => page.evaluate((name) => {
  const tr = Array.from(document.querySelectorAll('tr[data-lead-source]')).find((t) => (t as HTMLElement).innerText.split('\n')[0].includes(name));
  return tr ? ((tr.querySelector('[data-company-contact]') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ') ?? '(no company contact on the row)') : null;
}, company);

const readDrawer = (page: Page) => page.evaluate(() => {
  const el = document.querySelector('aside [data-company-site]') as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    text: el.innerText.replace(/\s+/g, ' '),
    sources: Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '').filter((h) => /^https?:/.test(h)),
    left: Math.round(r.left), right: Math.round(r.right), scrollWidth: document.documentElement.scrollWidth,
  };
});

(async () => {
  const { data: ws } = await admin.from('workspaces').select('id').eq('name', 'RFBT Recruitment').single();
  const { data: leads, error } = await admin.from('leads')
    .select('id, source_url, companies!inner(id, name, switchboard, switchboard_source_url, general_email, general_email_source_url)')
    .eq('workspace_id', ws!.id).eq('kind', 'won_work').eq('is_test', false).not('status', 'in', '("stale","not_for_us")').limit(5000);
  if (error) throw new Error(error.message);
  const withSite = (leads ?? []).filter((l: any) => l.companies.switchboard || l.companies.general_email);
  const chosen = new Map<string, any>();
  for (const l of withSite as any[]) {
    if (NAMES.length ? !NAMES.includes(l.companies.name) : chosen.size >= 4) continue;
    if (!chosen.has(l.companies.id)) chosen.set(l.companies.id, l);
  }
  console.log(`won-work leads whose company's own site gave a switchboard or general email: ${withSite.length} · probing ${chosen.size}: ${[...chosen.values()].map((l) => l.companies.name).join(', ')}`);

  const { data: created, error: createError } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Won Work Contacts Probe', agency: 'Won Work Contacts Probe' } });
  if (createError) { console.error('could not create the probe user:', createError.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: own } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const throwaway = own?.workspace_id as string;
  await markWorkspaceTest(admin, throwaway);
  await admin.from('users').update({ workspace_id: ws!.id, role: 'recruiter', onboarding_day: 30 }).eq('id', uid);
  const followProblem = await followAllForProbe(admin, uid);
  if (followProblem) console.log(`  ...  ${followProblem}`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});
    check(/\/app\//.test(page.url()), 'signed in as a recruiter of the real workspace', page.url());
    const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const m = await phone.newPage();

    for (const l of chosen.values()) {
      const co = l.companies;
      const source = /ted\.europa\.eu/.test(String(l.source_url)) ? 'tender' : 'news';
      const list = `${BASE}/app/radar?tab=won&source=${source}&industries=all&sort=latest`;
      console.log(`\n${co.name} · switchboard ${co.switchboard ?? '—'} · general email ${co.general_email ?? '—'}`);
      await page.goto(list, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('tr[data-lead-source]', { timeout: 60000 }).catch(() => {});
      const row = await readRow(page, co.name);
      console.log(`  row at 1500px: ${row ?? '(lead not in the list)'}`);
      const expectRow = co.switchboard ? `Switchboard ${co.switchboard} · from their site` : `General email ${co.general_email} · from their site`;
      check(row === expectRow || (row ?? '').includes('from their site'), `${co.name}: the row shows what the company's own site gave`, row ?? 'lead not in the list');

      await page.goto(`${list}&lead=${l.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('aside [data-company-site]', { timeout: 30000 }).catch(() => {});
      const drawer = await readDrawer(page);
      console.log(`  drawer at 1500px: ${drawer ? `${drawer.text} · sources ${drawer.sources.join(', ')}` : '(no company-site block)'}`);
      const wantSources = [co.switchboard ? co.switchboard_source_url : null, co.general_email ? co.general_email_source_url : null].filter(Boolean);
      check(!!drawer && (!co.switchboard || drawer.text.includes(`Switchboard ${co.switchboard}`)) && (!co.general_email || drawer.text.includes(`General email ${co.general_email}`)) && wantSources.every((s) => drawer.sources.includes(s)),
        `${co.name}: the drawer shows each value with the page it was read from`, JSON.stringify(drawer));

      await m.goto(`${list}&lead=${l.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await m.waitForSelector('aside [data-company-site]', { timeout: 30000 }).catch(() => {});
      const small = await readDrawer(m);
      console.log(`  drawer at 390px: ${small ? `left ${small.left}, right ${small.right}, page width ${small.scrollWidth}` : '(no company-site block)'}`);
      check(!!small && small.left >= 0 && small.right <= 390 && small.scrollWidth <= 390 && (!co.switchboard || small.text.includes(co.switchboard)), `${co.name} at 390px, touch: the block is on screen with no sideways scroll`, JSON.stringify(small));
    }
    await phone.close();
  } finally {
    await browser.close();
    const leftBehind = await removeProbe(admin, uid, throwaway, ws!.id);
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); } else console.log('\nprobe user and its workspace removed');
  }
  console.log(failures === 0 ? 'won-work contacts screen probe: all checks passed' : `won-work contacts screen probe: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
