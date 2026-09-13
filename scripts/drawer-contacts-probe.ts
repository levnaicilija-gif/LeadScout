/**
 * Do the Hiring now drawers show the people stored for their companies — to a signed-in user?
 *
 *   npx tsx --env-file=.env.local scripts/drawer-contacts-probe.ts https://leadscout-rfbt.vercel.app
 *
 * Signs in as a throwaway user placed in the real workspace (the design-shots trick: real data,
 * real RLS), opens each company's drawer and reads "Who to contact" off the screen. For every
 * company with contacts on file and open postings it checks that each organisation-page name the
 * database holds is on screen. The three named companies must be among them.
 *
 * Writes nothing but the throwaway user and its own (test-marked) workspace, deleted afterwards.
 * Exits 1 if any stored name is missing from its drawer.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { markWorkspaceTest, removeProbe } from '../src/lib/test-data';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const EMAIL = `contacts-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = 'probe-password-0123456789';
const MUST = ['Karstensens', 'AIBEL', 'businessinwind'];
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

(async () => {
  const { data: ws } = await admin.from('workspaces').select('id').eq('name', 'RFBT Recruitment').single();
  // Contacts that hang from a company alone, on companies with open postings: the ones RLS hid.
  const { data: stored } = await admin.from('contacts').select('name, title, company_id, companies!inner(name, workspace_id)').is('lead_id', null).not('source_url', 'is', null);
  const { data: open } = await admin.from('job_posts').select('company_id').eq('status', 'open');
  const openIds = new Set((open ?? []).map((p: any) => p.company_id));
  const targets = (stored ?? []).filter((c: any) => c.companies.workspace_id === ws!.id && openIds.has(c.company_id));
  console.log(`company-level contacts on companies with open postings: ${targets.length}`);
  for (const m of MUST) check(targets.some((t: any) => t.companies.name === m), `${m} has an organisation-page contact on file`);

  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Contacts Probe', agency: 'Contacts Probe' } });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: own } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const throwaway = own?.workspace_id as string;
  await markWorkspaceTest(admin, throwaway);
  await admin.from('users').update({ workspace_id: ws!.id, role: 'senior', onboarding_day: 30 }).eq('id', uid);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});
    check(/\/app\//.test(page.url()), 'signed in as a user of the real workspace');

    const byCompany = new Map<string, any[]>();
    for (const t of targets) byCompany.set(t.company_id, [...(byCompany.get(t.company_id) ?? []), t]);
    for (const [companyId, people] of byCompany) {
      const name = people[0].companies.name;
      await page.goto(`${BASE}/app/radar?tab=hiring&company=${companyId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => { const a = document.querySelector('aside'); return !!a && !a.innerText.includes('Reading what we hold'); }, undefined, { timeout: 60000 }).catch(() => {});
      const drawer = await page.locator('aside').first().innerText().catch(() => '');
      // Name AND title: the same person can also be printed on an advert, without the title the
      // organisation page gave. businessinwind's Talitha van der Vuurst showed that way while her
      // stored contact was still hidden, so a name on screen alone proves nothing about this source.
      for (const p of people) {
        const shown = drawer.includes(p.name) && (!p.title || drawer.includes(p.title));
        check(shown, `${name}: "${p.name}" with her or his stored title "${p.title}" is shown under Who to contact`, shown ? '' : drawer.replace(/\s+/g, ' ').slice(0, 240));
      }
    }
  } finally {
    await browser.close();
    // Its own throwaway workspace only, never the real one it borrowed; a leftover fails this run.
    const leftBehind = await removeProbe(admin, uid, throwaway, ws!.id);
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); }
  }
  console.log(failures === 0 ? '\ndrawer contacts: all checks passed' : `\ndrawer contacts: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
