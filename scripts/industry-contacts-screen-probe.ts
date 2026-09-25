/**
 * The "Industry Contacts" rename, read off production screens by a signed-in recruiter of the real workspace.
 *
 *   npx tsx --env-file=.env.local scripts/industry-contacts-screen-probe.ts https://leadscout-rfbt.vercel.app
 *
 * Finds a Won work lead with people linked from an event list and no quoted contact, and a Hiring now company whose
 * contact sheet offers such people; opens both at 1500px and at 390px on a touch screen. Passes when the row reads
 * "N from Industry Contacts", the lead drawer reads "People at this company from Industry Contacts", Hiring now's badge
 * reads "Industry Contacts", and no page shows the word "attendee" anywhere. Labels only: the data it reads is unchanged.
 *
 * A throwaway account enters the real workspace as a recruiter following all industries and is removed afterwards
 * with its own test-marked workspace; a leftover fails the run. Writes nothing else.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe } from '../src/lib/test-data';
import { attendeeMatch } from '../src/lib/attendee-match';
import { isOps } from '../src/lib/contact-choice';
import { LEAD_STATE_LEFT, withLeadState } from '../src/lib/workspace-state';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const EMAIL = `industry-contacts-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = `probe-${Date.now()}-0123456789`;
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };
const oldWord = (page: Page) => page.evaluate(() => { const t = document.body.innerText; const i = t.search(/attendee/i); return i < 0 ? null : t.slice(Math.max(0, i - 60), i + 40).replace(/\s+/g, ' '); });

(async () => {
  const { data: ws } = await admin.from('workspaces').select('id').eq('name', 'RFBT Recruitment').single();
  // 0049 dropped leads.status; it comes from the workspace's state row, nested a level deeper inside
  // the lead embed. Each lead is flattened ONCE here so both `l.leads.status` reads below are unchanged.
  const { data: linkRows } = await admin.from('lead_people').select(`lead_id, leads!inner(id, kind, source_url, workspace_id, companies(name), ${LEAD_STATE_LEFT})`).eq('leads.workspace_id', ws!.id).eq('leads.kind', 'won_work').limit(400);
  const links = (linkRows ?? []).map((l: any) => ({ ...l, leads: withLeadState(l.leads) }));
  const leadIds = [...new Set(links.filter((l: any) => !['stale', 'not_for_us'].includes(l.leads.status)).map((l: any) => l.lead_id))];
  const { data: quoted } = leadIds.length ? await admin.from('contacts').select('lead_id').in('lead_id', leadIds) : { data: [] as any[] };
  const withQuote = new Set((quoted ?? []).map((q: any) => q.lead_id));
  const leadLink: any = links.find((l: any) => !withQuote.has(l.lead_id) && !['stale', 'not_for_us'].includes(l.leads.status));
  const { data: posts } = await admin.from('job_posts').select('company_id, companies!inner(name, workspace_id)').eq('status', 'open').eq('companies.workspace_id', ws!.id).limit(400);
  const { data: people } = await admin.from('people').select('company_name, title').eq('workspace_id', ws!.id).eq('ops_relevant', true).limit(20000);
  const hiringCo: any = (posts ?? []).find((p: any) => (people ?? []).some((x: any) => isOps(x.title) && attendeeMatch(p.companies.name, x.company_name)));
  console.log(`Won work lead with Industry Contacts and no quoted person: ${leadLink ? leadLink.leads.companies?.name : 'none found'} · Hiring now company with Industry Contacts on its sheet: ${hiringCo ? hiringCo.companies.name : 'none found'}`);

  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Industry Contacts Probe', agency: 'Industry Contacts Probe' } });
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

    if (leadLink) {
      const name = leadLink.leads.companies?.name as string;
      const source = /ted\.europa\.eu/.test(String(leadLink.leads.source_url)) ? 'tender' : 'news';
      const list = `${BASE}/app/radar?tab=won&source=${source}&industries=all&sort=latest`;
      await page.goto(list, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('tr[data-lead-source]', { timeout: 60000 }).catch(() => {});
      const cell = await page.evaluate((n) => { const tr = Array.from(document.querySelectorAll('tr[data-lead-source]')).find((t) => (t as HTMLElement).innerText.split('\n')[0].includes(n)); return tr ? (tr as HTMLElement).innerText.replace(/\s+/g, ' ') : null; }, name);
      check(!!cell && /\d+ from Industry Contacts/.test(cell), `${name}: the row reads "N from Industry Contacts"`, cell ?? 'lead not in the list');
      check((await oldWord(page)) === null, 'Leads at 1500px never says "attendee"', (await oldWord(page)) ?? '');
      for (const [p, width] of [[page, 1500], [m, 390]] as const) {
        await p.goto(`${list}&lead=${leadLink.lead_id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await p.waitForSelector('aside', { timeout: 30000 }).catch(() => {});
        const aside = await p.locator('aside').first().innerText().catch(() => '');
        check(/People at this company from Industry Contacts/.test(aside), `${name} drawer at ${width}px reads "People at this company from Industry Contacts"`, aside.replace(/\s+/g, ' ').slice(0, 160));
        check((await oldWord(p)) === null, `the lead drawer page at ${width}px never says "attendee"`, (await oldWord(p)) ?? '');
      }
    } else {
      check(false, 'a Won work lead with Industry Contacts to look at', 'none found');
    }

    if (hiringCo) {
      for (const [p, width] of [[page, 1500], [m, 390]] as const) {
        await p.goto(`${BASE}/app/radar?tab=hiring&industries=all&agencies=1&company=${hiringCo.company_id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await p.waitForFunction(() => { const a = document.querySelector('aside'); return !!a && !a.innerText.includes('Reading what we hold'); }, undefined, { timeout: 60000 }).catch(() => {});
        const aside = await p.locator('aside').first().innerText().catch(() => '');
        check(/Industry Contacts/.test(aside), `${hiringCo.companies.name} Hiring now drawer at ${width}px labels its people "Industry Contacts"`, aside.replace(/\s+/g, ' ').slice(0, 200));
        check((await oldWord(p)) === null, `the Hiring now drawer page at ${width}px never says "attendee"`, (await oldWord(p)) ?? '');
      }
    } else {
      check(false, 'a Hiring now company with Industry Contacts to look at', 'none found');
    }
    await phone.close();
  } finally {
    await browser.close();
    const leftBehind = await removeProbe(admin, uid, throwaway, ws!.id);
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); } else console.log('\nprobe user and its workspace removed');
  }
  console.log(failures === 0 ? 'industry contacts screen probe: all checks passed' : `industry contacts screen probe: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
