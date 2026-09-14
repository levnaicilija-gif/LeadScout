import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { markWorkspaceTest, removeProbe } from '@/lib/test-data';
import { hasTable } from '@/lib/schema-features';

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
 */

export type SweepRow = { table: string; service: number | string; expected: number | string | null; user: number | string; verdict: string };
export type SweepResult = {
  ok: boolean;
  ranAt: string;
  rows: SweepRow[];
  /** Tables a signed-in user reads fewer rows of than they should. */
  suspects: string[];
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
  outreach: (a, ws) => counted(a.from('outreach').select('id, leads!inner(workspace_id)', { count: 'exact', head: true }).eq('leads.workspace_id', ws)),
  verifications: (a, ws) => counted(a.from('verifications').select('id, documents!inner(workspace_id)', { count: 'exact', head: true }).eq('documents.workspace_id', ws)),
  scores: (a, ws) => counted(a.from('scores').select('id, candidates!inner(workspace_id)', { count: 'exact', head: true }).eq('candidates.workspace_id', ws)),
  sends: (a, ws) => counted(a.from('sends').select('id, candidates!inner(workspace_id)', { count: 'exact', head: true }).eq('candidates.workspace_id', ws)),
  anonymized_cvs: (a, ws) => counted(a.from('anonymized_cvs').select('id, candidates!inner(workspace_id)', { count: 'exact', head: true }).eq('candidates.workspace_id', ws)),
  campaign_candidates: (a, ws) => counted(a.from('campaign_candidates').select('campaign_id, campaigns!inner(workspace_id)', { count: 'exact', head: true }).eq('campaigns.workspace_id', ws)),
};

export async function runRlsSweep(opts: { workspaceName?: string } = {}): Promise<SweepResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const ranAt = new Date().toISOString();
  const result: SweepResult = { ok: false, ranAt, rows: [], suspects: [], unjudged: [], catalog: { checked: false, noPolicy: [] }, error: null, cleanupError: null };
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  let uid: string | null = null;
  let throwaway: string | null = null;
  let workspaceId: string | null = null;
  try {
    const specRes = await fetch(`${url}/rest/v1/`, { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` }, cache: 'no-store' });
    const spec: any = await specRes.json();
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
    const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: 'RLS Sweep', agency: 'RLS Sweep' } });
    if (createErr || !created.user) throw new Error(`could not create the sweep user: ${createErr?.message}`);
    uid = created.user.id;
    const { data: own } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
    throwaway = (own?.workspace_id as string) ?? null;
    if (throwaway) await markWorkspaceTest(admin, throwaway);
    // A recruiter, never the senior every new account starts as. What a user can read is decided by
    // workspace, not role, so the counts are the same — but on 2026-09-14 a failed delete left this
    // account behind inside the real workspace as a senior, until it was found and removed by hand.
    await admin.from('users').update({ workspace_id: workspaceId, role: 'recruiter' }).eq('id', uid);

    const user = createClient(url, anonKey, { auth: { persistSession: false } });
    const { error: signIn } = await user.auth.signInWithPassword({ email, password });
    if (signIn) throw new Error(`the sweep user could not sign in: ${signIn.message}`);

    const { data: links } = await admin.from('lead_articles').select('article_id, leads!inner(workspace_id)').eq('leads.workspace_id', workspaceId);
    const linkedArticles = new Set((links ?? []).map((r: any) => r.article_id)).size;

    for (const t of tables) {
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
    result.ok = result.suspects.length === 0 && result.catalog.noPolicy.length === 0;
  } catch (e: any) {
    result.error = String(e?.message ?? e).slice(0, 300);
    result.ok = false;
  } finally {
    // Kept on the result, not swallowed: this runs unattended every night, and an ignored delete would
    // leave one throwaway workspace behind per night with nothing to say so.
    // removeProbe retries once, five seconds on, and treats "already gone" as done: a single delete
    // failed with "fetch failed" during a transient Supabase outage on 2026-09-14.
    result.cleanupError = await removeProbe(admin, uid, throwaway, workspaceId);
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
  const { error } = await admin.from('health_checks').insert({
    kind: 'rls_sweep', ok: r.ok, source, ran_at: r.ranAt,
    detail: { suspects: r.suspects, unjudged: r.unjudged, catalog: r.catalog, error: r.error, cleanupError: r.cleanupError, tables: r.rows.length },
  });
  return error ? error.message : null;
}

/** One line a person can act on. */
export function sweepSummary(r: SweepResult): string {
  const cleanup = r.cleanupError ? ` · CLEANUP FAILED: ${r.cleanupError}` : '';
  if (r.error) return `rls sweep could not run: ${r.error}${cleanup}`;
  const parts: string[] = [];
  if (r.suspects.length) parts.push(`${r.suspects.length} table(s) a signed-in user reads less of than they should — ${r.suspects.join(', ')}`);
  if (r.catalog.noPolicy.length) parts.push(`RLS on with no policy — ${r.catalog.noPolicy.join(', ')}`);
  if (parts.length) return `rls sweep: ${parts.join('; ')}${cleanup}`;
  return `rls sweep: every table with rows reads the same for a signed-in user as for the service role${r.catalog.checked ? '; the catalogue shows no table with RLS on and no policy' : ''}${cleanup}`;
}
