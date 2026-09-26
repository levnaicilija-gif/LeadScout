import type { SupabaseClient } from '@supabase/supabase-js';
import { allRows } from './all-rows';

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

/**
 * Everything a probe made under one workspace, in one call.
 *
 * THE MARK ON THE WORKSPACE IS READ, AND A FAILURE TO SET IT THROWS (2026-09-22). It used to be
 * `await db.from('workspaces').update(...)` with the result discarded, and the function returned true
 * regardless — so a write that failed left the workspace unmarked, the probe ran on happily, and
 * removeProbe then REFUSED to delete it at the end precisely because it was not marked. A silent
 * failure at setup became a stranded workspace at teardown, and the next run inherited it: smoke left
 * "Smoke Test Agency" behind at 08:35 UTC holding eight cost_log rows, and the gate four hours later
 * failed on it. Exactly the same shape as the last_seen_at write that sat unread for four days.
 *
 * Throwing is right rather than harsh: a probe that cannot mark its workspace MUST NOT PROCEED,
 * because everything it creates from that point on is unremovable by its own cleanup. Better to fail
 * loudly in setup, where the message names the cause, than quietly in teardown, where it names a
 * workspace id and leaves somebody to work out why.
 *
 * The per-table marks below are still best-effort on purpose: a table that cannot be stamped is a
 * row that shows in a count somewhere, not an object nobody can delete.
 */
export async function markWorkspaceTest(db: SupabaseClient, workspaceId: string) {
  if (!(await haveFlag(db))) return false;
  const { error } = await db.from('workspaces').update({ is_test: true }).eq('id', workspaceId);
  if (error) throw new Error(`workspace ${workspaceId} could not be marked is_test (${error.code ?? '?'} ${error.message}) — refusing to seed into a workspace that cleanup would not be allowed to remove`);
  // Read back: an update that matched no row answers without an error, and an unmarked workspace is
  // exactly as unremovable as one whose update failed.
  const { data: back } = await db.from('workspaces').select('is_test').eq('id', workspaceId).maybeSingle();
  if (!back?.is_test) throw new Error(`workspace ${workspaceId} is still not marked is_test after the update — refusing to seed into it`);
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
    const { data: ws } = await withTransportRetry(() => db.from('workspaces').select('is_test').eq('id', workspaceId).maybeSingle());
    if (ws?.is_test) {
      const { error } = await withTransportRetry(() => db.from('cost_log').update({ workspace_id: null }).eq('workspace_id', workspaceId));
      if (error) return `workspace ${workspaceId} was not deleted: its cost_log rows could not be detached: ${error.message}`;
    }
  }
  let why = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let q = db.from('workspaces').delete().eq('id', workspaceId);
    if (flag) q = q.eq('is_test', true);
    const { error } = await withTransportRetry(() => q);
    const { data: still, error: readError } = await withTransportRetry(() => db.from('workspaces').select('id').eq('id', workspaceId).maybeSingle());
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
    const { data: ws } = await withTransportRetry(() => db.from('workspaces').select('is_test').eq('id', workspaceId).maybeSingle());
    if (!ws) return null; // already gone
    if (!ws.is_test) return `workspace ${workspaceId} is not marked is_test, so its content was not touched`;
  }
  const problems: string[] = [];
  // A CV-sent row (sends) and a score point at a candidate with no cascade, so they go first or the candidate delete fails
  // (item 24: the list probe and the scale test write CV-sent rows).
  const { data: cands } = await allRows((from, to) => db.from('candidates').select('id').eq('workspace_id', workspaceId).order('id').range(from, to));
  const ids = (cands ?? []).map((c: any) => c.id);
  for (let i = 0; i < ids.length; i += 200) {
    for (const table of ['sends', 'scores'] as const) {
      const { error } = await withTransportRetry(() => db.from(table).delete().in('candidate_id', ids.slice(i, i + 200)));
      if (error) problems.push(`${table} of workspace ${workspaceId}'s candidates were not deleted: ${error.message}`);
    }
  }
  for (const table of ['candidates', 'documents'] as const) {
    const { error } = await withTransportRetry(() => db.from(table).delete().eq('workspace_id', workspaceId));
    if (error) problems.push(`${table} in workspace ${workspaceId} were not deleted: ${error.message}`);
  }
  // 0037's deletion log references the workspace with no cascade, so a probe that deleted something leaves a row that
  // would stop the workspace being removed. Before 0037 there is no such table, and nothing to clear.
  const { error: logError } = await withTransportRetry(() => db.from('deletion_log').delete().eq('workspace_id', workspaceId));
  if (logError && !/deletion_log|schema cache|does not exist/i.test(logError.message)) problems.push(`the deletion log of workspace ${workspaceId} was not cleared: ${logError.message}`);
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
      const { error: sendsError } = await withTransportRetry(() => db.from('sends').delete().eq('sent_by', uid));
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
/**
 * The industry a probe workspace follows, chosen because NO real lead carries it.
 *
 * Not a trick: `pharma_life_sciences` is one of the sixteen industries a real account may follow, and
 * the reason it is safe is checked rather than assumed — capProbeToOneIndustry refuses if a real lead
 * ever turns up carrying it. A crawl that starts classifying pharma work would otherwise rot every
 * probe's isolation quietly, months from now, in a way that looks like a product bug.
 */
export const PROBE_INDUSTRY = 'pharma_life_sciences';

/**
 * A probe account follows ONE industry and is CAPPED, because that is what a real sign-up looks like.
 *
 * WHY THIS REPLACED followAllForProbe IN THE SCREEN PROBES (2026-09-25). They used to follow 'all' with
 * no cap, which is RFBT's shape — and RFBT is the ONLY unlimited account, grandfathered. Every future
 * sign-up chooses one industry at onboarding (0032) and is capped from its first screen. So an unlimited
 * throwaway workspace was testing an account type that will never sign up again.
 *
 * It matters from item 20 step 3c, when discovery became shared: an unlimited workspace sees the whole
 * entitled pool, so `smoke`, `today` and `queue-ids` started asserting counts against 229 of RFBT's real
 * leads mixed into their own handful — 16, 11 and 6 failures, every one of them the screen behaving
 * correctly. A capped workspace sees the pool its entitlement admits, which for PROBE_INDUSTRY is
 * nothing real, so the assertions mean again what they were written to mean.
 *
 * WHAT IT DOES NOT FIX, and this is deliberately left visible rather than worked around: Hiring now
 * reads job_posts through companies, and 5,653 of 5,893 companies carry no industry at all. An
 * unclassified row stays visible to a capped account — the owner's decision of 2026-09-25 — so the
 * board is still pool-wide. That is the recorded blocking precondition for the first real capped
 * customer, not something to paper over with a test-only branch in can_see_industries().
 */
/**
 * A TRANSPORT REJECTION IS NOT AN ANSWER, and treating it as one cost a gate on 2026-09-26: smoke failed
 * with "the probe account could not be capped to pharma_life_sciences: TypeError: fetch failed" — one blip
 * on the users update, no retry, the whole step red while the product was fine. This machine's documented
 * connect-exhaustion fault makes that likely rather than rare, and it bites hardest late in a gate, which
 * is exactly where the screen probes run. removeProbe has retried for this reason since 2026-09-14.
 *
 * Only a transport failure is retried. A Postgres error means the statement reached the database, so
 * repeating it returns the same answer and would hide a real fault behind a pause.
 *
 * EXPORTED 2026-09-26 after this class failed a gate for the FOURTH time in one night — first shared-pool's
 * cleanup, then capProbeToOneIndustry, then deleteTestWorkspace's cost_log detach, then today-probe's own
 * followup_resolutions delete. Wrapping the shared primitives was not enough because several probes clean up
 * rows that only they know about, with their own bare deletes. A probe that collects its own leftovers should
 * wrap each delete in this rather than writing a fifth private retry or, as every one of them did, none.
 */
const TRANSPORT_FAULT = /fetch failed|ETIMEDOUT|ECONNRESET|UND_ERR|socket hang up|network/i;
export async function withTransportRetry<T extends { error: { message: string } | null }>(run: () => PromiseLike<T>): Promise<T> {
  let last = await run();
  for (let i = 1; i <= 2 && last.error && TRANSPORT_FAULT.test(last.error.message); i++) {
    await new Promise((r) => setTimeout(r, 1500 * i));
    last = await run();
  }
  return last;
}

export async function capProbeToOneIndustry(db: SupabaseClient, uid: string, industry = PROBE_INDUSTRY): Promise<string | null> {
  // The guard first. If a real lead carries this industry the probe is no longer isolated, and every
  // count it asserts becomes a coin toss — so it fails here, loudly, naming what changed.
  const { count, error: checkErr } = await withTransportRetry(() => db.from('leads')
    .select('id', { count: 'exact', head: true })
    .contains('industries', [industry])
    .or('is_test.is.null,is_test.eq.false'));
  if (checkErr && checkErr.code !== '42703') return `could not check whether ${industry} is still unused by real leads: ${checkErr.message}`;
  if ((count ?? 0) > 0) {
    return `${count} REAL lead(s) now carry "${industry}", so a probe following it is no longer isolated — pick another unused industry for PROBE_INDUSTRY and re-check, or these probes will assert counts against real data`;
  }
  // THE SECOND CONDITION, and the one more likely to break. Isolation holds because every real lead is
  // CLASSIFIED — 229 of 229 on 2026-09-25 — so a capped account following an unused industry sees none of
  // them. An UNCLASSIFIED lead is visible to a capped account too (the owner's decision that an
  // unclassified row is never hidden), so the first real lead that misses classification would start
  // appearing in every probe's counts, intermittently, looking like flake. classifyAndStoreLead runs
  // inline in the crawl, so this is a failure of that call rather than a normal state.
  const { count: unclassified, error: unErr } = await withTransportRetry(() => db.from('leads')
    .select('id', { count: 'exact', head: true })
    .or('industries.is.null,industries.eq.{}')
    .or('is_test.is.null,is_test.eq.false'));
  if (unErr && unErr.code !== '42703') return `could not check for unclassified real leads: ${unErr.message}`;
  if ((unclassified ?? 0) > 0) {
    return `${unclassified} real lead(s) carry no industry, and an unclassified lead is visible to a capped account — so this probe's counts would include them. Classify them (scripts/industry-backfill.ts) or this isolation is not real`;
  }
  // Both fields together: 0032's trigger refuses 'all' beside a limit, and a limit under the list size.
  const { error } = await withTransportRetry(() => db.from('users')
    .update({ industry_follow: [industry], industry_limit: 1, industry_follow_set_at: new Date().toISOString() })
    .eq('id', uid));
  if (!error) return null;
  if (error.code === '42703' || (/industry_follow/.test(error.message) && /does not exist|schema cache/i.test(error.message))) return null;
  return `the probe account could not be capped to ${industry}: ${error.message}`;
}

export async function followAllForProbe(db: SupabaseClient, uid: string): Promise<string | null> {
  const { error } = await withTransportRetry(() => db.from('users').update({ industry_follow: ['all'], industry_follow_set_at: new Date().toISOString() }).eq('id', uid));
  if (!error || error.code === '42703' || /industry_follow/.test(error.message) && /does not exist|schema cache/i.test(error.message)) return null;
  return `the probe account could not be set to follow all industries: ${error.message}`;
}
