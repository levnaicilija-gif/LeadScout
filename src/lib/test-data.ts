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

/** Is the flag available? For a script that wants to say so in its output. */
export const testFlagAvailable = (db: SupabaseClient) => haveFlag(db);
