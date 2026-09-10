/**
 * Drive the lead drawer as a recruiter does: sign in, open a lead, press every tool, and
 * report what came back — a result, or a plain-language error, but never a button left
 * spinning. This is the check that would have caught "Writing…" forever.
 *
 *   npx tsx --env-file=.env.local scripts/lead-drawer-e2e.ts https://leadscout-rfbt.vercel.app
 *
 * Runs against a throwaway account seeded with one lead of its own, so it never writes to the
 * real workspace, and deletes everything afterwards.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const EMAIL = `drawer-e2e+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = 'probe-password-0123456789';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

/** Every tool, with the text that proves it produced something real. */
const TOOLS = [
  { tool: 'jd', button: 'Write JD', spinner: 'Writing…', proof: /Job Title|Positions|Responsibilities|Location/i },
  { tool: 'q', button: 'Get questions', spinner: 'Writing…', proof: /Good:/i },
  { tool: "pool", button: "Score the pool", spinner: "Scoring…", proof: /RFBT-|Create the job description first|No candidates in the pool yet/i },
];

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `\n        ${detail}` : ''}`);
};

(async () => {
  const { data: created, error } = await admin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
    user_metadata: { name: 'Drawer E2E', agency: 'Drawer E2E Agency' },
  });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me!.workspace_id as string;

  // A lead of its own, shaped like a real one: a company, a quoted person, an article.
  const { data: co } = await admin.from('companies').insert({ workspace_id: workspace, name: 'Probe Offshore AS', employer_type: 'end_client', country: 'NO' }).select().single();
  const { data: lead } = await admin.from('leads').insert({
    workspace_id: workspace, company_id: co!.id, kind: 'won_work',
    project_name: 'Maintenance and modification frame agreement',
    project_location: 'Norwegian Continental Shelf', country: 'NO',
    trades_inferred: ['welder', 'pipefitter', 'scaffolder'], fit_score: 80, status: 'new',
    source_url: 'https://example.invalid/probe-award', source_fetched_at: new Date().toISOString(),
  }).select().single();
  await admin.from('contacts').insert({
    lead_id: lead!.id, company_id: co!.id, name: 'Probe Person', title: 'Head of Operations',
    quote: 'We will need a significant number of trades from the first quarter.', email_status: 'unknown',
  });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    page.on('pageerror', (e) => console.log(`   PAGEERROR ${String(e?.message ?? e).slice(0, 300)}`));
    page.on('console', (m) => { if (m.type() === 'error') console.log(`   CONSOLE ${m.text().slice(0, 300)}`); });
    page.on('response', async (r) => {
      if (!/\/api\/lead/.test(r.url())) return;
      let body = ''; try { body = (await r.text()).slice(0, 160).replace(/\s+/g, ' '); } catch { body = '(unreadable)'; }
      console.log(`   NET ${r.status()} ${r.url().replace(BASE, '')}  ${body}`);
    });

    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});
    check(/\/app\//.test(page.url()), 'sign in', page.url());

    await page.goto(`${BASE}/app/radar?lead=${lead!.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    const drawerOpen = await page.locator('aside').first().isVisible().catch(() => false);
    check(drawerOpen, 'lead drawer opens');
    if (!drawerOpen) { console.log(await page.locator('body').innerText().catch(() => '')); throw new Error('no drawer'); }

    for (const t of TOOLS) {
      await page.locator(`button:has-text("${t.tool === 'jd' ? '1 · Need as a job description' : t.tool === 'pool' ? '2 · Score the pool' : '4 · Screening questions'}")`).first().click();
      await page.waitForTimeout(400);
      const btn = page.locator(`aside button.btn-primary:has-text("${t.button}")`).first();
      if (!(await btn.count())) { check(false, `${t.tool}: action button present`); continue; }
      await btn.click();

      // The contract: something must resolve within 60 s, and the spinner must not survive it.
      const started = Date.now();
      await page.waitForFunction(
        (spin) => !document.body.innerText.includes(spin as string),
        t.spinner, { timeout: 75000 },
      ).catch(() => {});
      const secs = Math.round((Date.now() - started) / 1000);
      const text = await page.locator('aside').first().innerText();
      const stuck = text.includes(t.spinner);
      const produced = t.proof.test(text);
      const errored = /text-bad/.test(await page.locator('aside').first().innerHTML()) && !produced;

      check(!stuck, `${t.tool}: never stuck on "${t.spinner}"`, `settled in ${secs}s`);
      check(produced || errored, `${t.tool}: shows a result or a plain error`, produced ? 'result rendered' : 'error shown');
    }
  } finally {
    await browser.close();
    await admin.from('outreach').delete().eq('lead_id', lead!.id);
    await admin.from('contacts').delete().eq('lead_id', lead!.id);
    await admin.from('scores').delete().eq('lead_id', lead!.id);
    await admin.from('leads').delete().eq('id', lead!.id);
    await admin.from('companies').delete().eq('id', co!.id);
    await admin.auth.admin.deleteUser(uid);
    await admin.from('workspaces').delete().eq('id', workspace);
    console.log('\ncleaned up the probe user, its workspace and its lead');
  }
  console.log(failures === 0 ? '\nlead drawer: all checks passed' : `\nlead drawer: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
