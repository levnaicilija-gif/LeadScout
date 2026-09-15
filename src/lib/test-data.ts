import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Marking probe and smoke data as what it is.
 *
 * These scripts create real rows in the real database. They already delete what they made, but
 * a cleanup that matches on anything other than "this row is test data" can take a real record
 * with it — a company name that collides, a candidate created a minute earlier by a person.
 * So the flag is explicit and the deletes filter on it.
 *
 * The rule is one-directional on purpose: a row without the flag is real, always. Nothing here
 * ever clears the flag or sets it on a row it did not create.
 *
 * Guarded, because is_test arrives with migration 0020 and a script must still run without it.
 */
const TABLES = ['workspaces', 'companies', 'leads', 'candidates', 'job_posts', 'documents', 'contacts', 'outreach'] as const;
export type TestTable = (typeof TABLES)[number];

let supported: boolean | null = null;

async function haveFlag(db: SupabaseClient): Promise<boolean> {
  if (supported !== null) return supported;
  const { error } = await db.from('workspaces').select('is_test').limit(1);
  supported = !(error && (error.code === '42703' || /column .* does not exist/i.test(error.message)));
  return supported;
}

/** Stamp rows as test data. Silent when 0020 is not applied — the scripts still work. */
export async function markTest(db: SupabaseClient, table: TestTable, ids: string[]) {
  if (!ids.length || !(await haveFlag(db))) return false;
  const { error } = await db.from(table).update({ is_test: true }).in('id', ids);
  return !error;
}

/** Everything a probe made under one workspace, in one call. */
export async function markWorkspaceTest(db: SupabaseClient, workspaceId: string) {
  if (!(await haveFlag(db))) return false;
  await db.from('workspaces').update({ is_test: true }).eq('id', workspaceId);
  for (const t of ['companies', 'leads', 'candidates', 'documents', 'contacts', 'outreach'] as const) {
    await db.from(t).update({ is_test: true }).eq('workspace_id', workspaceId);
  }
  return true;
}

/**
 * Delete a probe's rows, and refuse to touch anything not marked.
 *
 * When the flag exists the filter is belt and braces: the workspace id already scopes it, and
 * is_test then guarantees that a mistake in that scoping cannot reach a real record.
 */
export async function deleteTestRows(db: SupabaseClient, table: TestTable, column: string, value: string) {
  let q = db.from(table).delete().eq(column, value);
  if (await haveFlag(db)) q = q.eq('is_test', true);
  return q;
}

/**
 * Delete a probe's throwaway workspace, and say whether it went.
 *
 * Probes used to fire this delete and ignore the answer. On 2026-09-13 the release gate's design-shots
 * run left an empty "Design Shots" workspace behind with nothing printed, found only by counting
 * is_test rows afterwards. This never deletes the workspace a probe borrowed (`keep`), filters on
 * is_test when the flag exists, tries twice, confirms the row is gone, and returns why it is not —
 * or null once it is.
 */
export async function deleteTestWorkspace(db: SupabaseClient, workspaceId: string | null | undefined, keep?: string | null): Promise<string | null> {
  if (!workspaceId || workspaceId === keep) return null;
  const flag = await haveFlag(db);
  // Item 16: a probe's recruiter tools log real spend against its workspace, and cost_log.workspace_id has no cascade, so
  // those rows would block the delete. They are kept — the money was spent and still counts in the day — detached from
  // the workspace; each row's detail already says "test workspace". Only a workspace marked is_test is touched.
  if (flag) {
    const { data: ws } = await db.from('workspaces').select('is_test').eq('id', workspaceId).maybeSingle();
    if (ws?.is_test) {
      const { error } = await db.from('cost_log').update({ workspace_id: null }).eq('workspace_id', workspaceId);
      if (error) return `workspace ${workspaceId} was not deleted: its cost_log rows could not be detached: ${error.message}`;
    }
  }
  let why = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let q = db.from('workspaces').delete().eq('id', workspaceId);
    if (flag) q = q.eq('is_test', true);
    const { error } = await q;
    const { data: still, error: readError } = await db.from('workspaces').select('id').eq('id', workspaceId).maybeSingle();
    if (!error && !readError && !still) return null;
    why = error
      ? `${error.code ?? ''} ${error.message}`.trim()
      : readError ? `could not confirm it was gone: ${readError.message}` : 'it is still there after the delete — is it marked is_test?';
    if (attempt === 1) await new Promise((r) => setTimeout(r, 2000));
  }
  return `workspace ${workspaceId} was not deleted: ${why}`;
}

/**
 * Empty a probe's own test workspace of the rows a signed-in flow creates in it, in foreign-key order.
 *
 * Found 2026-09-13: verify-e2e's gate run at 20:06 UTC left its user, its workspace, a candidate
 * (RFBT-P-0196), that candidate's anonymised CV and three documents behind. candidates.created_by and
 * documents.uploaded_by point at the user with no cascade, so while either row stands the user cannot
 * be deleted, and while the user stands the workspace cannot — and none of those deletes was read.
 * Candidates go first (their documents, verifications, anonymised CVs and downloads cascade), then any
 * document without a candidate. Refuses a workspace that is `keep` or is not marked is_test.
 */
export async function clearTestWorkspace(db: SupabaseClient, workspaceId: string | null | undefined, keep?: string | null): Promise<string | null> {
  if (!workspaceId || workspaceId === keep) return null;
  if (await haveFlag(db)) {
    const { data: ws } = await db.from('workspaces').select('is_test').eq('id', workspaceId).maybeSingle();
    if (!ws) return null; // already gone
    if (!ws.is_test) return `workspace ${workspaceId} is not marked is_test, so its content was not touched`;
  }
  const problems: string[] = [];
  // A CV-sent row (sends) and a score point at a candidate with no cascade, so they go first or the candidate delete fails
  // (item 24: the list probe and the scale test write CV-sent rows).
  const { data: cands } = await db.from('candidates').select('id').eq('workspace_id', workspaceId).limit(10000);
  const ids = (cands ?? []).map((c: any) => c.id);
  for (let i = 0; i < ids.length; i += 200) {
    for (const table of ['sends', 'scores'] as const) {
      const { error } = await db.from(table).delete().in('candidate_id', ids.slice(i, i + 200));
      if (error) problems.push(`${table} of workspace ${workspaceId}'s candidates were not deleted: ${error.message}`);
    }
  }
  for (const table of ['candidates', 'documents'] as const) {
    const { error } = await db.from(table).delete().eq('workspace_id', workspaceId);
    if (error) problems.push(`${table} in workspace ${workspaceId} were not deleted: ${error.message}`);
  }
  return problems.length ? problems.join('; ') : null;
}

/**
 * A probe's whole cleanup: optionally its workspace's content, then its auth user, then its own
 * workspace. Returns what was left behind, or null.
 *
 * Every probe and gate script ran these deletes and read none of the answers. A caller counts a
 * non-null result as a failure, so a leftover is heard the run it happens rather than found later by
 * counting rows. The workspace must be marked is_test first (markWorkspaceTest). The whole sequence is
 * tried twice, five seconds apart: a flow that has only just settled on screen can still be writing on
 * the server, which is the likeliest way verify-e2e's candidate appeared after its deletes had run.
 */
export async function removeProbe(
  db: SupabaseClient,
  uid: string | null | undefined,
  workspaceId: string | null | undefined,
  keep?: string | null,
  opts: { clearContent?: boolean } = {},
): Promise<string | null> {
  let left: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    left = [];
    if (opts.clearContent) {
      const notCleared = await clearTestWorkspace(db, workspaceId, keep);
      if (notCleared) left.push(notCleared);
    }
    if (uid) {
      // A CV-sent row records who sent it (sends.sent_by, no cascade), and one that points at no candidate is not reached
      // through the workspace's candidates — on 2026-09-15 such rows kept a scale-test account from being deleted. A probe
      // account is throwaway, so everything it sent is test data.
      const { error: sendsError } = await db.from('sends').delete().eq('sent_by', uid);
      if (sendsError) left.push(`CV-sent rows sent by the probe user ${uid} were not deleted: ${sendsError.message}`);
      const { error } = await db.auth.admin.deleteUser(uid);
      // Already gone — removed by the first attempt — is what was wanted.
      if (error && !/not.?found/i.test(error.message)) left.push(`the probe user ${uid} was not deleted: ${error.message}`);
    }
    const notDeleted = await deleteTestWorkspace(db, workspaceId, keep);
    if (notDeleted) left.push(notDeleted);
    if (!left.length) return null;
    if (attempt === 1) await new Promise((r) => setTimeout(r, 5000));
  }
  return left.join('; ');
}

/** Is the flag available? For a script that wants to say so in its output. */
export const testFlagAvailable = (db: SupabaseClient) => haveFlag(db);

/**
 * A probe account that is not testing onboarding follows every industry, so it reaches the screen it came to check.
 * From 0032 a new account is sent to choose industries before any other screen. Before 0032 there is nothing to
 * set; any other failure is returned for the caller to report.
 */
export async function followAllForProbe(db: SupabaseClient, uid: string): Promise<string | null> {
  const { error } = await db.from('users').update({ industry_follow: ['all'], industry_follow_set_at: new Date().toISOString() }).eq('id', uid);
  if (!error || error.code === '42703' || /industry_follow/.test(error.message) && /does not exist|schema cache/i.test(error.message)) return null;
  return `the probe account could not be set to follow all industries: ${error.message}`;
}
