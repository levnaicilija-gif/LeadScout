import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { markWorkspaceTest, removeProbe } from '@/lib/test-data';
import { hasTable } from '@/lib/schema-features';
import { followedIndustries } from '@/lib/industry-follow';

/**
 * Row level security, table by table: does a signed-in user see what they should?
 *
 * The bug this hunts has been found three times: RLS switched on with no policy. The user reads
 * nothing and gets no error, while every job — running as the service role — sees everything, so
 * nothing looks wrong until a screen is empty. It hid organisation-page contacts until 0022, and
 * articles, lead_articles and lead_people until 0025, the last three switched on outside the
 * migrations entirely.
 *
 * Every table the API exposes is counted as the service role and as a throwaway user placed in the
 * real workspace. SUSPECT means the user reads fewer rows than they should: the workspace's rows
 * where a table has workspace_id, the workspace itself for workspaces, the articles behind the
 * workspace's leads for articles, every row otherwise. A table with no rows cannot be judged by
 * counting; the catalogue check (0026) names those that have RLS on and no policy at all.
 *
 * Runs in the release gate (scripts/rls-sweep.ts) and nightly with the recheck cron. A sweep that
 * could not run is not a pass: it comes back ok: false with the reason.
 *
 * SINCE ITEM 44 THERE ARE TWO ARMS, because one account can no longer answer both questions. The UNCAPPED
 * account above answers "is any table hidden that should not be" by comparing against the service role. A
 * CAPPED account answers "does the entitlement show exactly what it should" — see the long note further
 * down. Before that, 0061's cap made a correct entitlement read as a hidden-table defect.
 */

export type SweepRow = { table: string; service: number | string; expected: number | string | null; user: number | string; verdict: string };
export type SweepResult = {
  ok: boolean;
  ranAt: string;
  rows: SweepRow[];
  /** Tables a signed-in user reads fewer rows of than they should. */
  suspects: string[];
  /** ITEM 44's second arm: what a CAPPED account reads of each entitlement-governed table, against what it is entitled to. */
  capped: SweepRow[];
  /** Entitlement-governed tables a capped account does not read exactly its entitlement of — too few OR too many. */
  cappedSuspects: string[];
  /** Entitlement-governed tables whose entitled count could not be computed, so nothing is claimed about them. */
  cappedUnjudged: string[];
  /** Tables with no rows, which counting cannot judge. */
  unjudged: string[];
  /** From the database catalogue once 0026 exists: RLS enabled and no policy of any kind. */
  catalog: { checked: boolean; noPolicy: string[] };
  /** Why the sweep could not run, when it could not. */
  error: string | null;
  /** The throwaway user or workspace that could not be removed afterwards. Not an RLS failure; never hidden either. */
  cleanupError: string | null;
};

const count = async (c: SupabaseClient, table: string, scope?: { column: string; value: string }): Promise<number | string> => {
  let q = c.from(table).select('*', { count: 'exact', head: true });
  if (scope) q = q.eq(scope.column, scope.value);
  const { count: n, error } = await q;
  return error ? `error ${error.code ?? ''} ${error.message.slice(0, 60)}` : (n ?? 0);
};

const counted = async (q: PromiseLike<{ count: number | null; error: any }>): Promise<number | string> => {
  const { count: n, error } = await q;
  return error ? `error ${error.code ?? ''} ${String(error.message).slice(0, 60)}` : (n ?? 0);
};

/**
 * Tables with no workspace_id of their own, counted through the parent that scopes them — the same
 * path their policies take. Counting every row instead made a correct table look hidden the moment a
 * second workspace held rows in it: a smoke run's seeded contacts, a probe's, one day a second client's.
 */
const THROUGH_PARENT: Record<string, (a: SupabaseClient, ws: string) => Promise<number | string>> = {
  contacts: async (a, ws) => {
    const onLeads = await counted(a.from('contacts').select('id, leads!inner(workspace_id)', { count: 'exact', head: true }).eq('leads.workspace_id', ws));
    const onCompanies = await counted(a.from('contacts').select('id, companies!inner(workspace_id)', { count: 'exact', head: true }).is('lead_id', null).eq('companies.workspace_id', ws));
    return typeof onLeads === 'number' && typeof onCompanies === 'number' ? onLeads + onCompanies : (typeof onLeads === 'string' ? onLeads : onCompanies);
  },
  lead_articles: (a, ws) => counted(a.from('lead_articles').select('lead_id, leads!inner(workspace_id)', { count: 'exact', head: true }).eq('leads.workspace_id', ws)),
  lead_people: (a, ws) => counted(a.from('lead_people').select('lead_id, leads!inner(workspace_id)', { count: 'exact', head: true }).eq('leads.workspace_id', ws)),
  verifications: (a, ws) => counted(a.from('verifications').select('id, documents!inner(workspace_id)', { count: 'exact', head: true }).eq('documents.workspace_id', ws)),
  scores: (a, ws) => counted(a.from('scores').select('id, candidates!inner(workspace_id)', { count: 'exact', head: true }).eq('candidates.workspace_id', ws)),
  sends: (a, ws) => counted(a.from('sends').select('id, candidates!inner(workspace_id)', { count: 'exact', head: true }).eq('candidates.workspace_id', ws)),
  anonymized_cvs: (a, ws) => counted(a.from('anonymized_cvs').select('id, candidates!inner(workspace_id)', { count: 'exact', head: true }).eq('candidates.workspace_id', ws)),
  campaign_candidates: (a, ws) => counted(a.from('campaign_candidates').select('campaign_id, campaigns!inner(workspace_id)', { count: 'exact', head: true }).eq('campaigns.workspace_id', ws)),
  // 0040: an answer has no workspace of its own and is scoped through its call, the way a
  // verification is scoped through its document. screening_calls carries workspace_id itself.
  screening_answers: (a, ws) => counted(a.from('screening_answers').select('id, screening_calls!inner(workspace_id)', { count: 'exact', head: true }).eq('screening_calls.workspace_id', ws)),
};

/**
 * ITEM 44 — THE CAPPED ARM, because "a user reads what the service role reads" stopped being true.
 *
 * The sweep above compares an UNCAPPED account against the service role, and that premise is kept exactly
 * as it was: it is the only thing that catches RLS switched on with no policy, the bug found three times
 * here. What it can no longer do is tell a HIDDEN TABLE from a WORKING ENTITLEMENT. 0061 caps every new
 * sign-up at one industry, so once real customers are capped a correct `read_leads` policy makes a user read
 * far fewer rows than the service role — and on 2026-10-01 that is precisely what happened: the sweep
 * reported leads 0 of 259, companies 5,636 of 5,912 and contacts 2 of 94 as a defect. Those counts were
 * right and the verdict was wrong, which is the worst thing a check can produce.
 *
 * THE FIX IS A SECOND ACCOUNT, NOT A LOOSER PASS CONDITION. Relaxing the comparison to "reads fewer is
 * fine" was the tempting one-line change and would have retired the check: an entitlement is indistinguishable
 * from a missing policy under that rule, so the next dashboard change that drops a policy would pass. Instead
 * a capped account reads each entitlement-governed table and must read EXACTLY what it is entitled to —
 * fewer is a hidden table, MORE is a leak, and both fail.
 *
 * THE EXPECTED COUNT IS DERIVED INDEPENDENTLY, never by calling `can_see_industries`. A check that asks the
 * function under test what the answer should be proves nothing; this reimplements the policy's predicate
 * (unclassified, or overlapping the followed leaves) against the service role's own rows, which is the same
 * method `candidate-pool-scale` uses — "exactly what an independent filter over the seeded records returns".
 * That is deliberate duplication inside a CHECK, and the opposite of the warning against a second
 * implementation in PRODUCT code: there the database already applies the rule, here nothing else can judge it.
 *
 * `followedIndustries` supplies the leaf expansion rather than a hardcoded pair, and it is already held to
 * `industry_follow_leaves` by `entitlement-probe` for every id 0032 allows — so the two cannot drift apart
 * without that check failing first.
 */
const CAPPED_FOLLOW = ['wind'];

/**
 * 'wind' DELIBERATELY. 0032 offers it as ONE option that expands to TWO leaves (offshore_wind, onshore_wind),
 * so an expansion that silently stopped expanding changes the expected count and is caught — where a
 * single-leaf industry would pass either way. It is also the one grouping this schema actually has.
 */
const cappedLeaves = (): string[] => {
  const f = followedIndustries(CAPPED_FOLLOW);
  return f === 'all' ? [] : (f as string[]);
};

/** The policy's predicate, as a PostgREST filter: unclassified rows stay visible, else the row must touch a followed leaf. */
const entitledFilter = (leaves: string[]) => `industries.is.null,industries.eq.{},industries.ov.{${leaves.join(',')}}`;

/** Every id of a shared parent the capped account is entitled to, paged and reading its error. */
async function entitledIds(a: SupabaseClient, table: 'leads' | 'companies', leaves: string[]): Promise<string[] | string> {
  const out: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await a.from(table).select('id').or(entitledFilter(leaves)).order('id').range(from, from + 999);
    // A failed page returns { data: null, error } and would look exactly like the end of the table — the
    // class this codebase keeps meeting. A short list here would understate the entitlement and manufacture
    // a SUSPECT on a correct table, which would redden Home for everyone from the nightly cron.
    if (error) return `error ${error.code ?? ''} ${error.message.slice(0, 60)}`;
    out.push(...(data ?? []).map((r: any) => String(r.id)));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** Every row of a small dependent table, as the service role, so the expectation can be computed in code. */
async function allOf(a: SupabaseClient, table: string, cols: string): Promise<any[] | string> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await a.from(table).select(cols).order(cols.split(',')[0].trim()).range(from, from + 999);
    if (error) return `error ${error.code ?? ''} ${error.message.slice(0, 60)}`;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function runRlsSweep(opts: { workspaceName?: string } = {}): Promise<SweepResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const ranAt = new Date().toISOString();
  const result: SweepResult = { ok: false, ranAt, rows: [], suspects: [], capped: [], cappedSuspects: [], cappedUnjudged: [], unjudged: [], catalog: { checked: false, noPolicy: [] }, error: null, cleanupError: null };
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  let uid: string | null = null;
  let throwaway: string | null = null;
  let workspaceId: string | null = null;
  let cappedUid: string | null = null;
  let cappedWs: string | null = null;
  try {
    // The table list, retried. On 2026-09-14 a manual run of the nightly job got an HTML gateway page
    // here instead of JSON ("Unexpected token '<'") and the sweep reported that it could not run.
    let spec: any = null;
    let specProblem = '';
    for (let attempt = 1; attempt <= 3 && !spec; attempt++) {
      try {
        const specRes = await fetch(`${url}/rest/v1/`, { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` }, cache: 'no-store' });
        const body = await specRes.text();
        if (!specRes.ok) specProblem = `HTTP ${specRes.status}`;
        else {
          try { spec = JSON.parse(body); } catch { specProblem = `HTTP ${specRes.status} but not JSON (it began: ${body.trim().slice(0, 40)})`; }
        }
      } catch (e: any) {
        specProblem = String(e?.message ?? e).slice(0, 100);
      }
      if (!spec && attempt < 3) await new Promise((res) => setTimeout(res, attempt * 5000));
    }
    if (!spec) throw new Error(`the API did not list its tables after 3 attempts: ${specProblem}`);
    const tables = Object.keys(spec?.definitions ?? {}).sort();
    if (!tables.length) throw new Error('the API listed no tables');
    const columns = (t: string) => Object.keys(spec.definitions[t]?.properties ?? {});

    const { data: ws, error: wsErr } = await admin.from('workspaces').select('id').eq('name', opts.workspaceName ?? 'RFBT Recruitment').single();
    if (wsErr || !ws) throw new Error(`the real workspace was not found: ${wsErr?.message ?? 'no row'}`);
    workspaceId = ws.id;

    // The catalogue, when 0026 has added the function: exact for the bug class, empty tables included.
    const { data: gaps, error: gapErr } = await admin.rpc('rls_tables_without_policy');
    if (!gapErr) result.catalog = { checked: true, noPolicy: ((gaps ?? []) as any[]).map((g) => String(g.table_name ?? g)).sort() };

    const email = `rls-sweep+${Date.now()}@rfbt-recruitment.com`;
    const password = `${globalThis.crypto.randomUUID()}-Aa1`;
    // Retried with the same address: on 2026-09-14 one "Gateway Timeout" here turned Home's check red for
    // everyone and failed the gate. A create that timed out may still have happened, so an "already
    // registered" answer is looked up and used — a second address would leave the first account behind.
    let createProblem = '';
    for (let attempt = 1; attempt <= 3 && !uid; attempt++) {
      const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: 'RLS Sweep', agency: 'RLS Sweep' } });
      if (created?.user) { uid = created.user.id; break; }
      createProblem = createErr?.message ?? 'no user returned';
      if (/already|registered|exists/i.test(createProblem)) {
        const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
        const found = list?.users.find((u) => u.email === email);
        if (found) { uid = found.id; await admin.auth.admin.updateUserById(found.id, { password }); break; }
      }
      if (attempt < 3) await new Promise((res) => setTimeout(res, attempt * 5000));
    }
    if (!uid) throw new Error(`could not create the sweep user after 3 attempts: ${createProblem}`);
    const { data: own } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
    throwaway = (own?.workspace_id as string) ?? null;
    if (throwaway) await markWorkspaceTest(admin, throwaway);
    // A recruiter, never the senior every new account starts as. What a user can read is decided by
    // workspace, not role, so the counts are the same — but on 2026-09-14 a failed delete left this
    // account behind inside the real workspace as a senior, until it was found and removed by hand.
    // UNLIMITED, DELIBERATELY (2026-10-01). This sweep's whole method is to compare what a signed-in user
    // reads against what the service role reads, and to fail when the user reads FEWER rows. 0061 caps every
    // new sign-up at one industry, so the moment it shipped this account became capped-and-unchosen and the
    // sweep reported the entitlement working as a hidden-rows defect: leads 0 of 259, companies 5,636 of
    // 5,912, contacts 2 of 94. Those numbers were correct and the verdict was wrong, which is the worst
    // combination a check can produce. An uncapped account restores the premise the comparison needs.
    //
    // THE GAP THAT LEFT IS NOW CLOSED BY THE CAPPED ARM BELOW (item 44, 2026-10-02), not by relaxing this
    // comparison: this account stays uncapped so "a user reads what the service role reads" still catches a
    // missing policy, and a SECOND, capped account is measured against its entitlement separately.
    await admin.from('users').update({ workspace_id: workspaceId, role: 'recruiter', industry_follow: ['all'], industry_limit: null }).eq('id', uid);

    const user = createClient(url, anonKey, { auth: { persistSession: false } });
    const { error: signIn } = await user.auth.signInWithPassword({ email, password });
    if (signIn) throw new Error(`the sweep user could not sign in: ${signIn.message}`);

    const { data: links } = await admin.from('lead_articles').select('article_id, leads!inner(workspace_id)').eq('leads.workspace_id', workspaceId);
    const linkedArticles = new Set((links ?? []).map((r: any) => r.article_id)).size;

    // Tables no signed-in user should read at all, by design and by migration. Judged by the user reading
    // none of them, rows or not; the catalogue check above still requires each to have its policy.
    // 0049's two backups belong here for the same reason jobs and job_ticks do, and they are the
    // clearer case: they hold a COPY of what one workspace decided, so a signed-in user reading any
    // of it would be exactly the leak item 20 exists to close. Without this line the sweep falls
    // through to the workspace-scoped branch, expects all 5,893 rows, and reports SUSPECT on a table
    // that is behaving correctly — which is what it did on 2026-09-25.
    //
    // They are also REVOKED from anon and authenticated, not merely policy-scoped, so a signed-in
    // read comes back as an ERROR rather than as zero rows. This branch already handles that: `leak`
    // is true only for a numeric count above zero, and an error means the table was not read. That is
    // the 0028 rule — a revoke is the real lock and a policy is the second one — and it is right to
    // keep both on a table holding a copy of private activity.
    const SERVICE_ONLY: Record<string, string> = {
      jobs: '0027, the worker queue',
      job_ticks: '0029, the crawl schedule log',
      // 0055 moved radar_runs from a workspace policy to a service-role marker policy. THIS ENTRY MUST SHIP
      // WITH THAT MIGRATION: without it the sweep compares 704 service-role rows against 0 for a signed-in
      // user, reports the table hidden, fails the gate and reddens Home for everyone — which is exactly what
      // 0049 backup tables did. It is the crawl cursor and tally; no screen reads it.
      radar_runs: '0055, the crawl cursor and tally',
      leads_2c_backup: "0049, the pre-drop copy of leads' per-workspace columns",
      companies_2c_backup: "0049, the pre-drop copy of companies' per-workspace columns",
    };
    for (const t of tables) {
      if (SERVICE_ONLY[t]) {
        const seen = await count(user, t);
        const leak = typeof seen === 'number' && seen > 0;
        if (leak) result.suspects.push(t);
        const verdict = leak ? `SUSPECT — the user reads ${seen} rows of a service-role-only table` : `ok — service role only (${SERVICE_ONLY[t]})`;
        result.rows.push({ table: t, service: await count(admin, t), expected: 0, user: seen, verdict });
        continue;
      }
      const scoped = t === 'workspaces' || columns(t).includes('workspace_id');
      const all = await count(admin, t);
      const expected = t === 'workspaces' ? await count(admin, t, { column: 'id', value: workspaceId! })
        : scoped ? await count(admin, t, { column: 'workspace_id', value: workspaceId! })
          : t === 'articles' ? linkedArticles
            : THROUGH_PARENT[t] ? await THROUGH_PARENT[t](admin, workspaceId!) : all;
      const judgedInWorkspace = scoped || t === 'articles' || !!THROUGH_PARENT[t];
      const seen = await count(user, t);
      let verdict = 'ok';
      if (typeof seen === 'string') { verdict = `SUSPECT — the user gets ${seen}`; result.suspects.push(t); }
      else if (all === 0) { verdict = 'not judged — no rows'; result.unjudged.push(t); }
      // A scoping query that failed is not a pass: say the table could not be judged.
      else if (typeof expected === 'string') { verdict = `not judged — the workspace's rows could not be counted: ${expected}`; result.unjudged.push(t); }
      else if (typeof expected === 'number' && seen < expected) { verdict = `SUSPECT — the user sees ${seen} of ${expected}`; result.suspects.push(t); }
      else if (typeof expected === 'number' && seen > expected) verdict = 'ok — shared rows beyond the workspace';
      else if (expected === 0) verdict = 'ok — no rows in this workspace';
      result.rows.push({ table: t, service: all, expected: judgedInWorkspace ? expected : null, user: seen, verdict });
    }

    // ---- ITEM 44: the capped arm ------------------------------------------------------------------
    // A second throwaway account, capped at one industry and FOLLOWING one, reads the seven tables 0053
    // put behind the entitlement. It must read exactly what it is entitled to. See the note above the
    // helpers for why this is a second account rather than a looser pass condition.
    const leaves = cappedLeaves();
    if (!leaves.length) throw new Error(`the capped arm could not expand ${CAPPED_FOLLOW.join(',')} into industry leaves`);

    const cappedEmail = `rls-sweep-capped+${Date.now()}@rfbt-recruitment.com`;
    const cappedPassword = `${globalThis.crypto.randomUUID()}-Aa1`;
    let cappedProblem = '';
    for (let attempt = 1; attempt <= 3 && !cappedUid; attempt++) {
      const { data: created, error: createErr } = await admin.auth.admin.createUser({ email: cappedEmail, password: cappedPassword, email_confirm: true, user_metadata: { name: 'RLS Sweep Capped', agency: 'RLS Sweep Capped' } });
      if (created?.user) { cappedUid = created.user.id; break; }
      cappedProblem = createErr?.message ?? 'no user returned';
      if (/already|registered|exists/i.test(cappedProblem)) {
        const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
        const found = list?.users.find((u) => u.email === cappedEmail);
        if (found) { cappedUid = found.id; await admin.auth.admin.updateUserById(found.id, { password: cappedPassword }); break; }
      }
      if (attempt < 3) await new Promise((res) => setTimeout(res, attempt * 5000));
    }
    if (!cappedUid) throw new Error(`could not create the capped sweep user after 3 attempts: ${cappedProblem}`);
    const { data: cappedOwn } = await admin.from('users').select('workspace_id').eq('id', cappedUid).maybeSingle();
    cappedWs = (cappedOwn?.workspace_id as string) ?? null;
    if (cappedWs) await markWorkspaceTest(admin, cappedWs);
    // CAPPED AND CHOSEN, which is the state a real customer is in. Capped-and-UNCHOSEN is already covered by
    // entitlement-cap-probe (it reads 0 classified rows); what nothing measured until now is whether a
    // customer who HAS chosen reads their whole entitlement and nothing beyond it.
    const { error: capErr } = await admin.from('users').update({ workspace_id: workspaceId, role: 'recruiter', industry_follow: CAPPED_FOLLOW, industry_limit: 1 }).eq('id', cappedUid);
    // 0032's trigger refuses a bad follow/limit pairing, and an unread error here would leave this account
    // UNCAPPED — the arm would then pass by measuring the wrong thing, which is how drawer-contacts-probe
    // silently tested nothing on 2026-10-01.
    if (capErr) throw new Error(`the capped sweep user could not be capped, so its arm would prove nothing: ${capErr.message}`);
    const { data: capCheck } = await admin.from('users').select('industry_limit, industry_follow').eq('id', cappedUid).maybeSingle();
    if (Number(capCheck?.industry_limit) !== 1) throw new Error(`the capped sweep user reads industry_limit ${String(capCheck?.industry_limit)} — it must be 1, or the arm measures an uncapped account`);

    const cappedClient = createClient(url, anonKey, { auth: { persistSession: false } });
    const { error: cappedSignIn } = await cappedClient.auth.signInWithPassword({ email: cappedEmail, password: cappedPassword });
    if (cappedSignIn) throw new Error(`the capped sweep user could not sign in: ${cappedSignIn.message}`);

    const leadIds = await entitledIds(admin, 'leads', leaves);
    const companyIds = await entitledIds(admin, 'companies', leaves);
    const jobPosts = await allOf(admin, 'job_posts', 'id, company_id, lead_id');
    const contactRows = await allOf(admin, 'contacts', 'id, lead_id, company_id');
    const linkRows = await allOf(admin, 'lead_articles', 'article_id, lead_id');
    const peopleRows = await allOf(admin, 'lead_people', 'lead_id');

    const L = Array.isArray(leadIds) ? new Set(leadIds) : null;
    const C = Array.isArray(companyIds) ? new Set(companyIds) : null;
    const viaParent = (rows: any[] | string, keep: (r: any) => boolean): number | string =>
      typeof rows === 'string' ? rows : rows.filter(keep).length;

    // Each entry mirrors 0053's policy for that table and nothing else. job_posts and contacts carry TWO arms
    // (company OR lead) and a row is visible when EITHER parent is — written as an OR here for the same reason.
    const entitled: Record<string, () => number | string> = {
      leads: () => (L ? L.size : (leadIds as string)),
      companies: () => (C ? C.size : (companyIds as string)),
      job_posts: () => (!L || !C ? ((leadIds as string) || (companyIds as string)) : viaParent(jobPosts, (r) => (r.company_id && C.has(String(r.company_id))) || (r.lead_id && L.has(String(r.lead_id))))),
      contacts: () => (!L || !C ? ((leadIds as string) || (companyIds as string)) : viaParent(contactRows, (r) => (r.lead_id && L.has(String(r.lead_id))) || (r.company_id && C.has(String(r.company_id))))),
      lead_articles: () => (!L ? (leadIds as string) : viaParent(linkRows, (r) => L.has(String(r.lead_id)))),
      lead_people: () => (!L ? (leadIds as string) : viaParent(peopleRows, (r) => L.has(String(r.lead_id)))),
      // articles reaches its lead THROUGH lead_articles, so an article is visible when any link to it is —
      // distinct article ids, never the link count, and the 471 backing no lead stay service-only as under 0025.
      articles: () => {
        if (!L) return leadIds as string;
        if (typeof linkRows === 'string') return linkRows;
        return new Set(linkRows.filter((r: any) => L.has(String(r.lead_id))).map((r: any) => String(r.article_id))).size;
      },
    };

    for (const t of Object.keys(entitled).sort()) {
      if (!tables.includes(t)) continue;
      const service = await count(admin, t);
      const expected = entitled[t]();
      const seen = await count(cappedClient, t);
      let verdict = `ok — reads exactly its entitlement (${String(expected)})`;
      // A read that ERRORED, or an expectation that could not be computed, is NOT JUDGED rather than a
      // verdict either way: this runs nightly and shows on Home, and a manufactured SUSPECT on a correct
      // table reddens it for everyone. The same exit-2 idiom the registry and outreach probes use.
      if (typeof expected === 'string') { verdict = `not judged — the entitled rows could not be counted: ${expected}`; result.cappedUnjudged.push(t); }
      else if (typeof seen === 'string') { verdict = `not judged — the capped user gets ${seen}`; result.cappedUnjudged.push(t); }
      else if (seen < expected) { verdict = `SUSPECT — the capped user reads ${seen} of the ${expected} it is entitled to, so rows are hidden from it beyond the entitlement`; result.cappedSuspects.push(t); }
      else if (seen > expected) { verdict = `SUSPECT — the capped user reads ${seen} but is entitled to ${expected}: the entitlement is LEAKING rows it does not follow`; result.cappedSuspects.push(t); }
      result.capped.push({ table: t, service, expected, user: seen, verdict });
    }

    result.ok = result.suspects.length === 0 && result.cappedSuspects.length === 0 && result.catalog.noPolicy.length === 0;
  } catch (e: any) {
    result.error = String(e?.message ?? e).slice(0, 300);
    result.ok = false;
  } finally {
    // Kept on the result, not swallowed: this runs unattended every night, and an ignored delete would
    // leave one throwaway workspace behind per night with nothing to say so.
    // removeProbe retries once, five seconds on, and treats "already gone" as done: a single delete
    // failed with "fetch failed" during a transient Supabase outage on 2026-09-14.
    // BOTH accounts, and both reported. The capped arm doubles the number of throwaway accounts this sweep
    // creates, so it doubles what a failed delete can strand — and a stranded account sits in the REAL
    // workspace, which has happened twice (2026-09-14 via this sweep, 2026-09-16 via design-shots). Each
    // reason is kept; neither is allowed to hide the other.
    const left = [await removeProbe(admin, uid, throwaway, workspaceId), await removeProbe(admin, cappedUid, cappedWs, workspaceId)].filter(Boolean);
    result.cleanupError = left.length ? left.join(' · ') : null;
  }
  return result;
}

/**
 * Keep the result where Home can show it (0026's health_checks). Returns why it was not kept, or null.
 * Before 0026 there is nowhere to keep it, and that is said rather than treated as a failed sweep.
 *
 * Verdicts only — which tables, never how many rows: every signed-in user can read health_checks, and
 * per-table counts would show other workspaces' volumes.
 */
export async function recordRlsSweep(admin: SupabaseClient, r: SweepResult, source: 'gate' | 'cron' | 'manual'): Promise<string | null> {
  if (!(await hasTable(admin, 'health_checks'))) return 'health_checks does not exist yet (migration 0026)';
  const row = {
    kind: 'rls_sweep', ok: r.ok, source, ran_at: r.ranAt,
    // Verdicts only, never counts — every signed-in user can read health_checks, and the capped arm's
    // numbers are row volumes per industry, which is exactly the shape that must not be published.
    detail: { suspects: r.suspects, cappedSuspects: r.cappedSuspects, cappedUnjudged: r.cappedUnjudged, unjudged: r.unjudged, catalog: r.catalog, error: r.error, cleanupError: r.cleanupError, tables: r.rows.length, cappedTables: r.capped.length },
  };
  // Retried: the nightly job's record failed with "Gateway Timeout" on 2026-09-14, so not even the failure
  // was kept — and a result nobody keeps is a check nobody sees. A retry after a timed-out success can
  // store the row twice; Home reads only the newest, so that costs nothing.
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await admin.from('health_checks').insert(row);
    if (!error) return null;
    last = error.message;
    if (attempt < 3) await new Promise((res) => setTimeout(res, attempt * 5000));
  }
  return `${last} (after 3 attempts)`;
}

/** One line a person can act on. */
export function sweepSummary(r: SweepResult): string {
  const cleanup = r.cleanupError ? ` · CLEANUP FAILED: ${r.cleanupError}` : '';
  if (r.error) return `rls sweep could not run: ${r.error}${cleanup}`;
  const parts: string[] = [];
  if (r.suspects.length) parts.push(`${r.suspects.length} table(s) a signed-in user reads less of than they should — ${r.suspects.join(', ')}`);
  if (r.cappedSuspects.length) parts.push(`${r.cappedSuspects.length} table(s) a CAPPED account does not read exactly its entitlement of — ${r.cappedSuspects.join(', ')}`);
  if (r.catalog.noPolicy.length) parts.push(`RLS on with no policy — ${r.catalog.noPolicy.join(', ')}`);
  if (parts.length) return `rls sweep: ${parts.join('; ')}${cleanup}`;
  // The entitlement half is named explicitly, because "every table reads the same" is no longer the whole
  // claim: a capped account correctly reads FEWER rows, and what is being asserted of it is EXACTNESS.
  const cappedPart = r.capped.length
    ? `; a capped account reads exactly its entitlement on ${r.capped.length - r.cappedUnjudged.length} of ${r.capped.length} entitlement-governed table(s)${r.cappedUnjudged.length ? ` (${r.cappedUnjudged.length} not judged)` : ''}`
    : '';
  return `rls sweep: every table with rows reads the same for an UNCAPPED signed-in user as for the service role${cappedPart}${r.catalog.checked ? '; the catalogue shows no table with RLS on and no policy' : ''}${cleanup}`;
}
