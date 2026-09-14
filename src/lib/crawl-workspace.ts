import type { SupabaseClient } from '@supabase/supabase-js';
import { TED_SOURCE_URL } from '@/lib/tender/ingest';

/**
 * The workspace the shared crawl files its work under, named — never "the first workspace".
 *
 * Eleven jobs asked `workspaces.select('id').limit(1)`. With one workspace that was the workspace; on 2026-09-14 a
 * second one was created by a sign-up, and an unordered limit(1) may return either, so a job could file companies,
 * people and spend under an empty test workspace. Tender ingest already named its workspace through the TED sources
 * row, and every job now does the same. No row, or no workspace on it, is an error: a job that cannot say where its
 * work belongs does not run.
 *
 * Until the shared-crawl design lands, this is RFBT Recruitment's workspace.
 */
export async function crawlWorkspace(db: SupabaseClient): Promise<string> {
  const { data, error } = await db.from('sources').select('workspace_id').eq('url', TED_SOURCE_URL).maybeSingle();
  if (error) throw new Error(`the crawl's workspace could not be read from the ${TED_SOURCE_URL} sources row: ${error.message}`);
  if (!data?.workspace_id) throw new Error(`no workspace to file the crawl under: the ${TED_SOURCE_URL} sources row is missing or has none`);
  return data.workspace_id as string;
}
