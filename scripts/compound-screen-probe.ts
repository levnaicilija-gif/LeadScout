/**
 * Item 19 on real data, read off the screen by a signed-in user of the real workspace.
 *
 *   npx tsx --env-file=.env.local scripts/compound-screen-probe.ts https://leadscout-rfbt.vercel.app
 *
 * For every company scripts/compound-signals-report.ts would boost, opens Won work (news and awards separately, all
 * industries, so a low fit is not cut by the top 50) and reads each of its leads' row — the boost line, "boosted, was N"
 * and the fit shown — then the lead drawer's reason, at 1500px and at 390px on a touch screen. With --hiring it also
 * reads the company's Hiring now row and drawer (item 19 step 2).
 *
 * A throwaway account enters the real workspace as a recruiter following all industries, and is removed afterwards
 * with its own test-marked workspace; a leftover fails the run. Writes nothing else.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe, probeAdmin } from '../src/lib/test-data';
import { compoundFor, leadSignal, postingSignals, boostedFit, type Signal } from '../src/lib/compound-signals';
import { CLOSED_LEAD_STATUSES, LEAD_STATE_EMBED, LEAD_STATE_TABLE } from '../src/lib/workspace-state';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const HIRING = process.argv.includes('--hiring');
const EMAIL = `compound-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = `probe-${Date.now()}-0123456789`;
const admin = probeAdmin();

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };

async function boostedCompanies(workspaceId: string) {
  const { data: leads } = await admin.from('leads').select(`id, company_id, country, fit_score, source_url, created_at, project_name, companies(name), ${LEAD_STATE_EMBED}`)
    .eq('workspace_id', workspaceId).eq('kind', 'won_work').not(`${LEAD_STATE_TABLE}.status`, 'in', CLOSED_LEAD_STATUSES).not('company_id', 'is', null).limit(5000);
  const ids = (leads ?? []).map((l) => l.id);
  const links: any[] = [];
  for (let i = 0; i < ids.length; i += 100) links.push(...((await admin.from('lead_articles').select('lead_id, articles(url, published_at, award_date, award_date_basis)').in('lead_id', ids.slice(i, i + 100))).data ?? []));
  const { data: posts } = await admin.from('job_posts').select('company_id, role, title, posted_at, first_seen_at').eq('status', 'open').not('company_id', 'is', null).limit(5000);
  const sig = new Map<string, Signal[]>();
  const add = (id: string, s: Signal[]) => sig.set(id, [...(sig.get(id) ?? []), ...s]);
  for (const l of leads ?? []) { const s = leadSignal({ ...l, lead_articles: links.filter((k) => k.lead_id === l.id).map((k) => ({ articles: k.articles })) }); if (s) add(l.company_id, [s]); }
  const postsBy = new Map<string, any[]>();
  for (const p of posts ?? []) postsBy.set(p.company_id, [...(postsBy.get(p.company_id) ?? []), p]);
  for (const [id, ps] of postsBy) add(id, postingSignals(ps));
  return [...sig.entries()].map(([id, s]) => ({ id, c: compoundFor(s), leads: (leads ?? []).filter((l) => l.company_id === id) })).filter((x) => x.c.factor > 1);
}

const rowFor = (page: Page, company: string) => page.evaluate((name) => {
  const tr = Array.from(document.querySelectorAll('tr[data-lead-source]')).find((t) => (t as HTMLElement).innerText.split('\n')[0].includes(name));
  if (!tr) return null;
  const boost = tr.querySelector('[data-compound]') as HTMLElement | null;
  const r = boost?.getBoundingClientRect();
  return {
    boost: boost?.innerText ?? '', from: (tr.querySelector('[data-fit-from]') as HTMLElement | null)?.innerText ?? '',
    fitCell: (tr.querySelectorAll('td')[5] as HTMLElement | undefined)?.innerText.replace(/\s+/g, ' ') ?? '',
    box: r ? { left: Math.round(r.left), right: Math.round(r.right), shown: r.width > 0 && r.height > 0 } : null,
  };
}, company);

(async () => {
  const { data: ws } = await admin.from('workspaces').select('id').eq('name', 'RFBT Recruitment').single();
  const targets = await boostedCompanies(ws!.id);
  console.log(`companies boosted by the data: ${targets.length}${targets.length ? ` — ${targets.map((t) => (t.leads[0] as any)?.companies?.name ?? t.id).join(', ')}` : ''}`);

  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Compound Probe', agency: 'Compound Probe' } });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
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

    for (const t of targets) {
      for (const l of t.leads) {
        const name = (l as any).companies?.name as string;
        const expected = boostedFit(l.fit_score ?? 0, t.c, l.country);
        const source = /ted\.europa\.eu/.test(String(l.source_url)) ? 'tender' : 'news';
        const list = `${BASE}/app/radar?tab=won&source=${source}&industries=all`;
        console.log(`\n${name} · "${String(l.project_name ?? '').slice(0, 50)}" · stored fit ${l.fit_score} · expected on screen ${expected.fit}`);
        await page.goto(list, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('tr[data-lead-source]', { timeout: 60000 }).catch(() => {});
        const row = await rowFor(page, name);
        console.log(`  row at 1500px: ${JSON.stringify(row)}`);
        check(!!row && row.boost === t.c.label && new RegExp(`\\b${expected.fit}\\b`).test(row.fitCell)
          && (expected.fit === expected.from ? /boost held by the cap/.test(row.from) : row.from === `boosted, was ${expected.from}`),
          `${name}: the row shows the boost, the signals and the fit before`, JSON.stringify(row));
        await page.goto(`${list}&lead=${l.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('aside [data-compound-why]', { timeout: 30000 }).catch(() => {});
        const why = await page.locator('aside [data-compound-why]').first().innerText().catch(() => '');
        console.log(`  drawer: ${why || '(no reason shown)'}`);
        check(why === expected.note, `${name}: the drawer gives the full reason`, why || 'no reason shown');
        await m.goto(list, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await m.waitForSelector('tr[data-lead-source]', { timeout: 60000 }).catch(() => {});
        const onPhone = await rowFor(m, name);
        console.log(`  row at 390px: ${JSON.stringify(onPhone)}`);
        check(!!onPhone?.box && onPhone.box.shown && onPhone.box.left >= 0 && onPhone.box.right <= 390 && onPhone.boost === t.c.label, `${name} at 390px: the boost is on screen without hover`, JSON.stringify(onPhone));
      }
      if (HIRING) {
        const name = (t.leads[0] as any)?.companies?.name ?? t.id;
        await page.goto(`${BASE}/app/radar?tab=hiring&industries=all&agencies=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('tr[data-row-href]', { timeout: 60000 }).catch(() => {});
        const hr = await page.evaluate((n) => {
          const tr = Array.from(document.querySelectorAll('tr[data-row-href]')).find((x) => (x as HTMLElement).innerText.split('\n')[0].includes(n));
          return tr ? { boost: (tr.querySelector('[data-compound]') as HTMLElement | null)?.innerText ?? '', pressure: (tr.querySelector('[data-pressure]') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ') ?? '' } : null;
        }, name);
        console.log(`  Hiring now row: ${JSON.stringify(hr)}`);
        check(!!hr && hr.boost === t.c.label && /boosted, was/.test(hr.pressure), `${name}: the Hiring now row shows the pressure boost and the signals`, JSON.stringify(hr));
        await page.goto(`${BASE}/app/radar?tab=hiring&industries=all&agencies=1&company=${t.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('aside [data-compound-why]', { timeout: 30000 }).catch(() => {});
        const hwhy = await page.locator('aside [data-compound-why]').first().innerText().catch(() => '');
        console.log(`  Hiring now drawer: ${hwhy || '(no reason shown)'}`);
        check(/^Boosted ×/.test(hwhy) && /Pressure /.test(hwhy), `${name}: the Hiring now drawer gives the full reason`, hwhy || 'no reason shown');
      }
    }
    await phone.close();
  } finally {
    await browser.close();
    const leftBehind = await removeProbe(admin, uid, throwaway, ws!.id);
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); } else console.log('\nprobe user and its workspace removed');
  }
  console.log(failures === 0 ? 'compound screen probe: all checks passed' : `compound screen probe: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
