/**
 * Item 18 part 3 — is the industry entitlement enforced on the server? Tried, not claimed.
 *
 *   npx tsx --env-file=.env.local scripts/industry-follow-probe.ts http://localhost:3000
 *
 * Throwaway accounts in their own is_test workspaces, signed in through the real login page; every request below is
 * made from that signed-in browser, as a user's own session would make it. Exits 0 only when every refusal happens
 * and the one allowed choice is stored. Exits 2 (not judged) when 0032 is not applied — nothing to enforce yet.
 */
import { chromium, type Page } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { markWorkspaceTest, removeProbe } from '../src/lib/test-data';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const PASSWORD = 'probe-password-0123456789';
let failed = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failed++; console.log(`${ok ? '  PASS' : '  FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };

type Probe = { uid: string; email: string; workspace: string };
async function account(tag: string): Promise<Probe> {
  const email = `follow-probe-${tag}+${Date.now()}@rfbt-recruitment.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { name: `Follow Probe ${tag}`, agency: `Follow Probe ${tag}` } });
  if (error || !data.user) throw new Error(`could not create ${tag}: ${error?.message}`);
  const { data: row } = await admin.from('users').select('workspace_id').eq('id', data.user.id).single();
  await markWorkspaceTest(admin, row!.workspace_id);
  return { uid: data.user.id, email, workspace: row!.workspace_id };
}
async function signIn(page: Page, p: Probe) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.fill('input[type=email]', p.email);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('form button:not([type=button])');
  await page.waitForURL(/\/app\//, { timeout: 60000 });
}
const call = (page: Page, path: string, body: unknown) => page.evaluate(async ([p, b]) => {
  const r = await fetch(p as string, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, [path, body] as const);

(async () => {
  const probe = await admin.from('users').select('industry_follow').limit(1);
  if (probe.error) { console.log(`not judged: 0032 is not applied (${probe.error.message})`); process.exitCode = 2; return; }

  const made: Probe[] = [];
  const browser = await chromium.launch();
  try {
    const capped = await account('capped'); made.push(capped);
    const senior = await account('senior'); made.push(senior);
    const recruiter = await account('recruiter'); made.push(recruiter);
    const outsider = await account('outsider'); made.push(outsider);
    // capped: a member of the senior's workspace, allowed two industries. recruiter: same workspace, a recruiter.
    for (const [p, fields] of [[capped, { workspace_id: senior.workspace, role: 'recruiter', industry_limit: 2 }], [recruiter, { workspace_id: senior.workspace, role: 'recruiter' }]] as const) {
      const { error } = await admin.from('users').update(fields).eq('id', p.uid);
      if (error) throw new Error(`could not set up ${p.email}: ${error.message}`);
    }
    for (const p of [senior, recruiter, outsider]) await admin.from('users').update({ industry_follow: ['all'] }).eq('id', p.uid);

    // 1 — straight to the database as the signed-in user: 0028 left no write on users.
    const asUser = createClient(url, anon, { auth: { persistSession: false } });
    await asUser.auth.signInWithPassword({ email: capped.email, password: PASSWORD });
    const direct = await asUser.from('users').update({ industry_follow: ['wind', 'grid', 'oil_gas'], industry_limit: null }).eq('id', capped.uid).select('id');
    check(!!direct.error || (direct.data ?? []).length === 0, 'a signed-in user writing their own industry_follow and industry_limit through the database API is refused', direct.error?.message ?? `${direct.data?.length} rows changed`);

    const cappedPage = await (await browser.newContext()).newPage();
    await signIn(cappedPage, capped);
    check(/\/app\/onboarding/.test(cappedPage.url()), 'a new account lands on industry onboarding, not on a screen', cappedPage.url().replace(BASE, ''));
    await cappedPage.goto(`${BASE}/app/radar`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    check(/\/app\/onboarding/.test(cappedPage.url()), 'Leads cannot be reached before choosing', cappedPage.url().replace(BASE, ''));

    // 2 — the route, over the limit and "all" under a limit: refused, and nothing stored.
    const tooMany = await call(cappedPage, '/api/me/industries', { follow: ['wind', 'grid', 'oil_gas'] });
    check(tooMany.status === 400, 'three industries on an account allowed two is refused by /api/me/industries', `${tooMany.status} ${JSON.stringify(tooMany.body)}`);
    const allUnderCap = await call(cappedPage, '/api/me/industries', { follow: ['all'] });
    check(allUnderCap.status === 400, '"all" on a capped account is refused', `${allUnderCap.status} ${JSON.stringify(allUnderCap.body)}`);
    const sneaky = await call(cappedPage, '/api/me/industries', { follow: ['wind', 'grid', 'oil_gas'], industry_limit: null, limit: 99 });
    check(sneaky.status === 400, 'a limit sent in the request is ignored — the limit is read from the account', `${sneaky.status} ${JSON.stringify(sneaky.body)}`);
    const { data: still } = await admin.from('users').select('industry_follow, industry_limit').eq('id', capped.uid).single();
    check(still?.industry_follow == null && still?.industry_limit === 2, 'after the refusals nothing was stored and the limit is unchanged', JSON.stringify(still));

    // 3 — below the routes: the trigger refuses the same writes from the service role.
    const trigger = await admin.from('users').update({ industry_follow: ['wind', 'grid', 'oil_gas'] }).eq('id', capped.uid);
    check(trigger.error?.code === '23514', "0032's trigger refuses three industries on a two-industry account even from the service role", trigger.error?.message ?? 'written');
    const triggerAll = await admin.from('users').update({ industry_follow: ['all'] }).eq('id', capped.uid);
    check(triggerAll.error?.code === '23514', 'the trigger refuses "all" on a capped account', triggerAll.error?.message ?? 'written');

    // 4 — within the limit: stored, and Leads opens on it.
    const ok = await call(cappedPage, '/api/me/industries', { follow: ['wind', 'grid'] });
    const { data: saved } = await admin.from('users').select('industry_follow, industry_follow_set_by').eq('id', capped.uid).single();
    check(ok.status === 200 && JSON.stringify(saved?.industry_follow) === '["wind","grid"]' && saved?.industry_follow_set_by === capped.uid, 'two industries within the limit are stored, set by the person', `${ok.status} ${JSON.stringify(saved)}`);
    await cappedPage.goto(`${BASE}/app/radar`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await cappedPage.waitForSelector('[data-industry-view], table.tbl', { timeout: 60000 }).catch(() => {});
    const leadsView = await cappedPage.evaluate(() => ({
      banner: (document.querySelector('[data-industry-view]') as HTMLElement | null)?.innerText ?? '',
      rows: document.querySelectorAll('tr[data-lead-source]').length,
      said: (document.querySelector('tbody td[colspan]') as HTMLElement | null)?.innerText ?? '',
      showAll: !!document.querySelector('[data-show-all-industries]'),
    }));
    check(/\/app\/radar/.test(cappedPage.url()) && /your industries/.test(leadsView.banner) && leadsView.showAll && (leadsView.rows > 0 || leadsView.said.length > 0),
      'after choosing, Leads opens on the chosen industries, says so, offers all industries in one click, and is never a bare empty table', JSON.stringify(leadsView));

    // 5 — the team route: a recruiter may not; a senior may, within the member's own limit, in their own workspace only.
    const recruiterPage = await (await browser.newContext()).newPage();
    await signIn(recruiterPage, recruiter);
    const asRecruiter = await call(recruiterPage, '/api/team/industries', { userId: capped.uid, follow: ['oil_gas'] });
    check(asRecruiter.status === 403, "a recruiter cannot change a teammate's industries", `${asRecruiter.status} ${JSON.stringify(asRecruiter.body)}`);
    const seniorPage = await (await browser.newContext()).newPage();
    await signIn(seniorPage, senior);
    const overMember = await call(seniorPage, '/api/team/industries', { userId: capped.uid, follow: ['oil_gas', 'grid', 'ccs'] });
    check(overMember.status === 400, "a senior cannot exceed the member's own limit (three for an account allowed two)", `${overMember.status} ${JSON.stringify(overMember.body)}`);
    const allForMember = await call(seniorPage, '/api/team/industries', { userId: capped.uid, follow: ['all'] });
    check(allForMember.status === 400, 'a senior cannot give a capped member "all"', `${allForMember.status} ${JSON.stringify(allForMember.body)}`);
    const otherWorkspace = await call(seniorPage, '/api/team/industries', { userId: outsider.uid, follow: ['grid'] });
    check(otherWorkspace.status === 404, "a senior cannot reach a member of another workspace", `${otherWorkspace.status} ${JSON.stringify(otherWorkspace.body)}`);
    const adjusted = await call(seniorPage, '/api/team/industries', { userId: capped.uid, follow: ['oil_gas'] });
    const { data: after } = await admin.from('users').select('industry_follow, industry_follow_set_by').eq('id', capped.uid).single();
    check(adjusted.status === 200 && JSON.stringify(after?.industry_follow) === '["oil_gas"]' && after?.industry_follow_set_by === senior.uid, "a senior adjusts a member within the member's limit, recorded as set by the senior", `${adjusted.status} ${JSON.stringify(after)}`);
  } catch (e: any) {
    failed++;
    console.log(`  FAIL  the probe could not finish: ${e.message ?? e}`);
  } finally {
    await browser.close();
    // The senior's workspace holds the two members moved into it, so it goes last.
    const order = [...made].sort((a, b) => Number(made.indexOf(a) === 1) - Number(made.indexOf(b) === 1));
    for (const p of order) {
      const left = await removeProbe(admin, p.uid, p.workspace);
      if (left) { failed++; console.log(`  FAIL  cleanup: ${left}`); }
    }
  }
  console.log(failed ? `industry follow probe: ${failed} failed` : 'industry follow probe: every refusal held and the allowed choices were stored');
  process.exitCode = failed ? 1 : 0;
})();
