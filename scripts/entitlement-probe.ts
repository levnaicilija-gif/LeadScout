/**
 * 0052: the entitlement function answers correctly for an unlimited account, for a CAPPED one, and for
 * nobody — and its expansion of the follow list agrees with TypeScript's.
 *
 *   npx tsx --env-file=.env.local scripts/entitlement-probe.ts
 *
 * WHY A PROBE AND NOT JUST THE MIGRATION'S DO BLOCK. auth.uid() is null inside a migration, so the block
 * can only reach the anonymous case. Everything that depends on WHO IS ASKING — which is the whole
 * function — can only be tested by signing in as a real account and calling it. And the branch that
 * matters most has no live example at all: all three real accounts are unlimited (industry_limit null,
 * follow ['all']) as of 2026-09-25, so the capped path has never once run. It only exists here.
 *
 * WHAT IS PROVEN, and each one is a decision somebody made rather than a mechanism:
 *
 *   1. UNLIMITED SEES EVERYTHING, including rows in industries it does not follow. The boundary is keyed
 *      on industry_limit, not on the follow, so an unlimited account's ?industries=all keeps working.
 *      Tested with a follow of ONE industry and a row in another — the case that would break if the
 *      database enforced the follow.
 *   2. CAPPED SEES ITS OWN INDUSTRIES AND NOT OTHERS — the boundary, which has no live example.
 *   3. UNCLASSIFIED STAYS VISIBLE TO A CAPPED ACCOUNT. Owner's decision 2026-09-25, and the one most
 *      likely to be lost by omission: 5,653 of 5,893 companies are in this case, so getting it backwards
 *      removes 96% of the book. Asserted directly, both for '{}' and for null.
 *   4. THE WIND GROUP EXPANDS. A follow of ['wind'] must match a row tagged offshore_wind. Both leaves
 *      are present in real data, and a plain array overlap would miss them.
 *   5. SQL AND TYPESCRIPT AGREE, for every id 0032 allows — industry_follow_leaves() against
 *      followedIndustries(). The rule lives in two places and this is the only thing that reads both.
 *   6. NO SESSION SEES NOTHING, checked as the anon key rather than inferred.
 *   7. THE 31 NULL-WORKSPACE JOB POSTS are governed rather than dropped. Measured 2026-09-25: all 31
 *      have a company, all 31 of those companies ARE classified, and NONE has a lead_id — so a
 *      lead-based policy at 3c would drop every one of them while a company-based one governs them.
 *      That is a finding about 3c's shape, proven here on the real rows.
 *
 * Nothing this probe does can change what anybody sees: 0052 is called from no policy yet.
 * Everything it makes is removed afterwards; a leftover fails the run.
 */
import { createClient } from '@supabase/supabase-js';
import { markWorkspaceTest, removeProbe } from '../src/lib/test-data';
import { FOLLOW_OPTIONS } from '../src/lib/industry';
import { followedIndustries } from '../src/lib/industry-follow';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const fail: string[] = [];
const ok: string[] = [];
function check(name: string, pass: boolean, detail: string) {
  (pass ? ok : fail).push(`${name} — ${detail}`);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
}

const admin = createClient(url, key, { auth: { persistSession: false } });

async function account(label: string, stamp: number) {
  const email = `entitlement-${label}+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: `Entitlement ${label}`, agency: `Entitlement ${label}` } });
  if (error) throw new Error(`could not create account ${label}: ${error.message}`);
  const uid = data.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error: signIn } = await client.auth.signInWithPassword({ email, password });
  if (signIn) throw new Error(`could not sign in as ${label}: ${signIn.message}`);
  return { uid, workspace, client };
}

/**
 * Ask the database, as this caller, whether a row with these industries is visible.
 *
 * `any` on the client and the call: 0052's functions are new, so the generated types do not know them
 * and `rpc()` types its argument as `undefined`. Casting is honest here — the shape is checked by the
 * call itself failing, and every result below is compared against an expected boolean.
 */
const sees = async (c: any, industries: string[] | null): Promise<boolean> => {
  const { data, error } = await c.rpc('can_see_industries', { row_industries: industries });
  if (error) throw new Error(`can_see_industries failed: ${error.code ?? '?'} ${error.message}`);
  if (typeof data !== 'boolean') throw new Error(`can_see_industries returned ${JSON.stringify(data)}, not a boolean`);
  return data;
};

/** The SQL expansion, for comparing against TypeScript's. */
const leaves = async (follow: string[]): Promise<string[]> => {
  const { data, error } = await (admin as any).rpc('industry_follow_leaves', { follow });
  if (error) throw new Error(`industry_follow_leaves failed: ${error.code ?? '?'} ${error.message}`);
  return (data ?? []) as string[];
};

async function main() {
  if (!url || !anonKey || !key) { console.error('URL, ANON_KEY and SERVICE_ROLE_KEY are required'); process.exitCode = 1; return; }

  const probe = await (admin as any).rpc('can_see_industries', { row_industries: ['grid'] });
  if (probe.error) {
    console.error(`can_see_industries is not callable (${probe.error.code ?? '?'} ${probe.error.message}) — apply 0052 first`);
    process.exitCode = 2; return;
  }

  const stamp = Date.now();
  let U: Awaited<ReturnType<typeof account>> | null = null;
  let C: Awaited<ReturnType<typeof account>> | null = null;

  try {
    // ---- 1. UNLIMITED, and deliberately following ONE industry only ------------------------------
    // The follow is set to something narrow on purpose: if the database enforced the follow rather than
    // the cap, this account would stop seeing grid rows and ?industries=all would silently do nothing.
    // A FOLLOW id, not an industry id — the two sets are different and only one is restricted.
    // FOLLOW_OPTIONS deliberately omits offshore_wind and onshore_wind, offering `wind` for both, so
    // 0032's trigger refuses `industry_follow: ['offshore_wind']` outright. It refused the first version
    // of this probe, which is the constraint doing its job. A ROW's industries are leaf ids and may be
    // offshore_wind; a FOLLOW may not.
    U = await account('unlimited', stamp);
    const { error: uErr } = await admin.from('users')
      .update({ industry_follow: ['grid'], industry_limit: null }).eq('id', U.uid);
    if (uErr) throw new Error(`could not set the unlimited account's follow: ${uErr.message}`);

    check('unlimited sees an industry it DOES follow', await sees(U.client, ['grid']), 'grid, followed');
    check('UNLIMITED SEES AN INDUSTRY IT DOES NOT FOLLOW', await sees(U.client, ['oil_gas']),
      'follow is [grid] and an oil_gas row is still visible — the boundary is the CAP, not the follow, so ?industries=all keeps working');
    check('unlimited sees an unclassified row', await sees(U.client, []), 'empty industries');

    // ---- 2 & 3. CAPPED — the branch with no live example -----------------------------------------
    C = await account('capped', stamp);
    const { error: cErr } = await admin.from('users')
      .update({ industry_follow: ['grid'], industry_limit: 1 }).eq('id', C.uid);
    if (cErr) throw new Error(`could not cap the capped account (0032's trigger may have refused it): ${cErr.message}`);
    const { data: capped } = await admin.from('users').select('industry_follow, industry_limit').eq('id', C.uid).maybeSingle();
    check('the capped account really is capped', capped?.industry_limit === 1 && JSON.stringify(capped?.industry_follow) === '["grid"]',
      `follow=${JSON.stringify(capped?.industry_follow)} limit=${capped?.industry_limit} — 0032's trigger accepted it`);

    check('capped sees its OWN industry', await sees(C.client, ['grid']), 'grid, followed');
    check('CAPPED DOES NOT SEE AN INDUSTRY IT DOES NOT FOLLOW', (await sees(C.client, ['offshore_wind'])) === false,
      'offshore_wind hidden — this is the boundary, and it has never run against a live account');
    check('capped does not see a row in several unfollowed industries', (await sees(C.client, ['oil_gas', 'petrochemical'])) === false,
      'oil_gas + petrochemical hidden');
    check('capped DOES see a row that touches its industry among others', await sees(C.client, ['oil_gas', 'grid']),
      'a row tagged both is visible — one overlap is enough, as inFollowed has always behaved');

    // 3. The owner's decision, asserted directly rather than inherited.
    check('UNCLASSIFIED STAYS VISIBLE TO A CAPPED ACCOUNT', await sees(C.client, []),
      "industries '{}' visible — owner's decision 2026-09-25; 5,653 of 5,893 companies are in this case, and hiding them would remove 96% of the book");
    check('and a NULL industries row likewise', await sees(C.client, null), 'null treated the same as empty');

    // ---- 4. The wind group -----------------------------------------------------------------------
    const W = await account('wind', stamp);
    try {
      const { error: wErr } = await admin.from('users').update({ industry_follow: ['wind'], industry_limit: 1 }).eq('id', W.uid);
      if (wErr) throw new Error(`could not set the wind follow: ${wErr.message}`);
      check('a follow of [wind] sees an OFFSHORE wind row', await sees(W.client, ['offshore_wind']),
        'the group expanded — a plain array overlap would have missed this, and both leaves exist in real data');
      check('and an ONSHORE wind row', await sees(W.client, ['onshore_wind']), 'the other leaf');
      check('but not a grid row', (await sees(W.client, ['grid'])) === false, 'the expansion widens the follow, it does not remove the boundary');
    } finally {
      for (const t of ['workspace_lead_state', 'workspace_company_state', 'leads', 'companies'] as const) await admin.from(t).delete().eq('workspace_id', W.workspace);
      const left = await removeProbe(admin, W.uid, W.workspace, null, { clearContent: true });
      if (left) check('the wind account was removed', false, left);
    }

    // ---- 5. SQL and TypeScript agree, for every id 0032 allows -----------------------------------
    // The rule lives in two places. This is the only thing that reads both, and it runs over the whole
    // allowed list rather than a sample, because a drift in ONE id is exactly what would slip through.
    const allowed = ['wind', ...FOLLOW_OPTIONS.map((o) => o.id)].filter((v, i, a) => a.indexOf(v) === i);
    const disagree: string[] = [];
    for (const id of allowed) {
      const sql = await leaves([id]);
      const ts = followedIndustries([id]);
      // 'all' is not an industry and is handled before the expansion is reached, so TS answering 'all'
      // is compared against the literal the SQL side produces for it rather than treated as a mismatch.
      const tsList = ts === 'all' ? [id] : ts;
      const a = [...sql].sort().join(',');
      const b = [...tsList].sort().join(',');
      if (a !== b) disagree.push(`${id}: SQL ${JSON.stringify(sql)} vs TS ${JSON.stringify(tsList)}`);
    }
    check(`SQL and TypeScript expand all ${allowed.length} follow ids identically`, disagree.length === 0,
      disagree.length ? disagree.join(' · ') : `every id agrees, including wind → ${JSON.stringify(await leaves(['wind']))}`);

    // ---- 6. No session sees nothing --------------------------------------------------------------
    const anonClient = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data: anonSees, error: anonErr } = await anonClient.rpc('can_see_industries', { row_industries: ['grid'] });
    check('an anonymous caller sees nothing', anonErr ? true : anonSees === false,
      anonErr ? `refused outright (${anonErr.code})` : `returned ${anonSees} — false is required, or a 3c policy of can_see_industries alone would open the pool`);

    // ---- 7. The 31 null-workspace job posts are governed, not dropped ---------------------------
    // The finding this proves is about 3c's SHAPE: keyed on the company these survive, keyed on the lead
    // they all vanish, whatever the entitlement says.
    const { data: orphans } = await admin.from('job_posts')
      .select('id, company_id, lead_id, companies(industries)').is('workspace_id', null);
    const rows = orphans ?? [];
    check('every null-workspace job post has a company to be judged by', rows.length > 0 && rows.every((p: any) => p.company_id),
      `${rows.length} row(s), ${rows.filter((p: any) => !p.company_id).length} without a company`);
    check('and NONE of them has a lead — so a lead-based policy at 3c would drop them all', rows.every((p: any) => !p.lead_id),
      `${rows.filter((p: any) => p.lead_id).length} of ${rows.length} have a lead_id`);
    // Judged through the company, an unlimited account sees all of them and the capped one sees exactly
    // those whose company touches grid. Both computed from the real rows, not asserted as a number.
    let uVisible = 0; let cVisible = 0;
    for (const p of rows as any[]) {
      const ind = (p.companies?.industries ?? []) as string[];
      if (await sees(U.client, ind)) uVisible++;
      if (await sees(C.client, ind)) cVisible++;
    }
    const expectCapped = (rows as any[]).filter((p: any) => ((p.companies?.industries ?? []) as string[]).includes('grid')).length;
    check('an unlimited account sees all of them', uVisible === rows.length, `${uVisible} of ${rows.length}`);
    check('and a capped account sees exactly those its follow covers', cVisible === expectCapped,
      `${cVisible} of ${rows.length} visible to a [grid] follow, and ${expectCapped} of their companies are tagged grid — governed, not dropped`);
  } finally {
    const leftovers: string[] = [];
    for (const who of [U, C].filter(Boolean) as NonNullable<typeof U>[]) {
      for (const t of ['workspace_lead_state', 'workspace_company_state', 'leads', 'companies'] as const) {
        const { error } = await admin.from(t).delete().eq('workspace_id', who.workspace);
        if (error) leftovers.push(`${t}: ${error.message}`);
      }
      const left = await removeProbe(admin, who.uid, who.workspace, null, { clearContent: true });
      if (left) leftovers.push(left);
    }
    // is_test, not a name pattern: a name-matching sweep missed "Drawer E2E Agency" on 2026-09-25.
    const { data: still } = await admin.from('workspaces').select('name').eq('is_test', true);
    if ((still ?? []).length) leftovers.push(`is_test workspaces remain: ${(still ?? []).map((w: any) => w.name).join(', ')}`);
    check('the probe cleans up after itself', !leftovers.length, leftovers.length ? leftovers.join('; ') : 'all three throwaway accounts and workspaces are gone');
  }

  console.log(`\n${ok.length} passed, ${fail.length} failed`);
  if (fail.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
