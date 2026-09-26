/**
 * The website trust lines on real data, read off the screen by a signed-in recruiter of the real workspace.
 *
 *   npx tsx --env-file=.env.local scripts/site-trust-screen-probe.ts https://leadscout-rfbt.vercel.app ["Company", …]
 *
 * For each named company (default ALLEZ ENERGIES, COLAS FRANCE, Aellia Belgium NV), what the database says —
 * domain_address_check, domain_checked_address, domain_scope — against what its Won work lead shows: the row's note, and
 * the drawer's trust lines, confirmed flag, scope and border, at 1500px and at 390px on a touch screen.
 *
 * A throwaway account enters the real workspace as a recruiter following all industries and is removed afterwards with its
 * own test-marked workspace; a leftover fails the run. One phone window for every company. Writes nothing else.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe, probeAdmin } from '../src/lib/test-data';
import { siteTrust } from '../src/lib/site-trust';
import { CLOSED_LEAD_STATUSES, LEAD_STATE_EMBED, LEAD_STATE_TABLE } from '../src/lib/workspace-state';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const NAMES = process.argv.slice(3).length ? process.argv.slice(3) : ['ALLEZ ENERGIES', 'COLAS FRANCE', 'Aellia Belgium NV (anciennement Intero the Sniffers)'];
const EMAIL = `site-trust-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = `probe-${Date.now()}-0123456789`;
const admin = probeAdmin();

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };

// The trust lines show wherever the drawer talks about the company's site: above its contacts, or above the prepared
// searches when the site gave none (COLAS FRANCE and Aellia on 2026-09-15). The border exists only with contacts.
const readDrawer = (page: Page) => page.evaluate(() => {
  const el = (document.querySelector('aside [data-company-site]') ?? document.querySelector('aside [data-prepared-searches]')) as HTMLElement | null;
  if (!el) return null;
  const box = el.hasAttribute('data-company-site') ? el.querySelector('div.border') as HTMLElement | null : null;
  const lines = Array.from(el.querySelectorAll('[data-site-trust]')) as HTMLElement[];
  return {
    confirmed: el.getAttribute('data-site-confirmed'), scope: el.getAttribute('data-site-scope'), border: box ? getComputedStyle(box).borderStyle : '',
    lines: lines.map((l) => ({ kind: l.getAttribute('data-site-trust'), text: l.innerText, color: getComputedStyle(l).color, left: Math.round(l.getBoundingClientRect().left), right: Math.round(l.getBoundingClientRect().right) })),
    scrollWidth: document.documentElement.scrollWidth,
  };
});

(async () => {
  const { data: ws } = await admin.from('workspaces').select('id').eq('name', 'RFBT Recruitment').single();
  const { data: cos, error } = await admin.from('companies')
    .select('id, name, domain, country, source, domain_source, domain_address_check, domain_checked_address, domain_scope, domain_scope_reason')
    .eq('workspace_id', ws!.id).in('name', NAMES);
  if (error) throw new Error(error.message);

  const { data: created, error: createError } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Site Trust Probe', agency: 'Site Trust Probe' } });
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

    for (const name of NAMES) {
      const co = (cos ?? []).find((c) => c.name === name);
      if (!co) { check(false, `${name}: on file`, 'no such company'); continue; }
      const expected = siteTrust(co);
      const { data: lead } = await admin.from('leads').select(`id, source_url, ${LEAD_STATE_EMBED}`).eq('company_id', co.id).eq('kind', 'won_work').not(`${LEAD_STATE_TABLE}.status`, 'in', CLOSED_LEAD_STATUSES).limit(1).maybeSingle();
      console.log(`\n${name} · ${co.domain} · database: check ${co.domain_address_check ?? '—'}${co.domain_checked_address ? ` (${co.domain_checked_address})` : ''} · scope ${co.domain_scope ?? '—'}${co.domain_scope_reason ? ` — ${co.domain_scope_reason}` : ''}`);
      if (!lead) { check(false, `${name}: has an open Won work lead`, 'none'); continue; }
      const source = /ted\.europa\.eu/.test(String(lead.source_url)) ? 'tender' : 'news';
      const list = `${BASE}/app/radar?tab=won&source=${source}&industries=all&sort=latest`;

      await page.goto(list, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('tr[data-lead-source]', { timeout: 60000 }).catch(() => {});
      const row = await page.evaluate((n) => {
        const tr = Array.from(document.querySelectorAll('tr[data-lead-source]')).find((t) => (t as HTMLElement).innerText.split('\n')[0].includes(n));
        return tr ? { contact: !!tr.querySelector('[data-company-contact]'), note: (tr.querySelector('[data-site-note]') as HTMLElement | null)?.innerText.replace(/^\s*·\s*/, '') ?? null } : null;
      }, name);
      console.log(`  row: ${row ? `${row.contact ? 'shows a contact from the site' : 'no contact from the site'} · note ${row.note ?? 'none'}` : '(lead not in the list)'}`);
      // The note qualifies a contact read off the site, so it is only expected where the row shows one.
      const wantNote = row?.contact ? expected?.rowNote ?? null : null;
      check(!!row && row.note === wantNote, `${name}: the row note is "${wantNote ?? 'none'}"`, JSON.stringify(row));

      await page.goto(`${list}&lead=${lead.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('aside [data-company-site], aside [data-prepared-searches]', { timeout: 30000 }).catch(() => {});
      const d = await readDrawer(page);
      console.log(`  drawer at 1500px: ${d ? `confirmed ${d.confirmed} · scope ${d.scope} · border ${d.border} · ${d.lines.map((l) => `[${l.kind}] ${l.text}`).join(' | ')}` : '(no company-site block — nothing was read off its site)'}`);
      if (d) {
        const doubtful = expected!.scope === 'group' || (expected!.check !== null && !expected!.confirmed);
        const borderOk = d.border === '' || d.border === (doubtful ? 'dashed' : 'solid');
        check(d.confirmed === String(expected!.confirmed) && d.scope === expected!.scope && d.lines.length === expected!.lines.length && d.lines.every((l, i) => l.text === expected!.lines[i].text) && borderOk,
          `${name}: the drawer says ${expected!.confirmed ? 'confirmed' : 'not confirmed'}${expected!.scope === 'group' ? ', group site' : ''}${d.border ? `, on a ${doubtful ? 'dashed warning' : 'plain'} border` : ' above the searches (its site gave no contacts)'}`);
      } else {
        check(false, `${name}: the drawer talks about its site`, 'neither a company-site block nor prepared searches');
      }

      await m.goto(`${list}&lead=${lead.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await m.waitForSelector('aside [data-company-site], aside [data-prepared-searches]', { timeout: 30000 }).catch(() => {});
      const s = await readDrawer(m);
      console.log(`  drawer at 390px: ${s ? `${s.lines.length} line(s), widest right edge ${Math.max(0, ...s.lines.map((l) => l.right))}, page width ${s.scrollWidth}` : '(no company-site block)'}`);
      check(!!s && s.lines.length === (expected?.lines.length ?? 0) && s.lines.every((l) => l.left >= 0 && l.right <= 390) && s.scrollWidth <= 390, `${name} at 390px, touch: every trust line on screen, no sideways scroll`, JSON.stringify(s?.lines.map((l) => [l.left, l.right])));
    }
    await phone.close();
  } finally {
    await browser.close();
    const leftBehind = await removeProbe(admin, uid, throwaway, ws!.id);
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); } else console.log('\nprobe user and its workspace removed');
  }
  console.log(failures === 0 ? 'site trust screen probe: all checks passed' : `site trust screen probe: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
