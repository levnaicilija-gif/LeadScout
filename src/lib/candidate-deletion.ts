import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Removing a candidate's data for good, and proving it went (item 24 follow-up 3, steps 7 and 8).
 *
 * The tables are every one that references a candidate or their documents (migrations 0001, 0009, 0035): documents and,
 * through them, verifications; anonymized_cvs; sends — by the candidate, or pointing at their client versions or scores;
 * scores; candidate_placements; campaign_candidates; internal_downloads. Stored files live in three buckets: `documents`
 * (each document's storage_path), `screenshots` (an issuer check's `<workspace>/verify/<document id>.png`) and `pdfs`
 * (each client version's storage_path).
 */
export const CANDIDATE_TABLES = ['candidates', 'documents', 'verifications', 'anonymized_cvs', 'sends', 'scores', 'candidate_placements', 'campaign_candidates', 'internal_downloads'] as const;
export type CandidateTable = (typeof CANDIDATE_TABLES)[number];
export type CandidateIds = { documents: { id: string; storage_path: string | null }[]; anonymizedCvs: { id: string; storage_path: string | null }[]; scores: string[] };

/** The ids a candidate's rows hang off — read before a deletion, so the count afterwards still knows where to look. */
export async function candidateIds(db: SupabaseClient, candidateId: string): Promise<CandidateIds> {
  const [docs, anon, scores] = await Promise.all([
    db.from('documents').select('id, storage_path').eq('candidate_id', candidateId),
    db.from('anonymized_cvs').select('id, storage_path').eq('candidate_id', candidateId),
    db.from('scores').select('id').eq('candidate_id', candidateId),
  ]);
  const failed = [docs, anon, scores].find((r) => r.error);
  if (failed) throw new Error(`the candidate's files could not be listed: ${failed.error!.message}`);
  return { documents: docs.data ?? [], anonymizedCvs: anon.data ?? [], scores: (scores.data ?? []).map((s: any) => s.id) };
}

/** Rows per table that belong to this candidate. A count that cannot be read throws: a deletion is never called clean on a guess. */
export async function candidateRowCounts(db: SupabaseClient, candidateId: string, ids: CandidateIds): Promise<Record<CandidateTable, number>> {
  const n = async (label: string, q: PromiseLike<{ count: number | null; error: any }>) => {
    const { count, error } = await q;
    if (error) throw new Error(`${label} could not be counted: ${error.message}`);
    return count ?? 0;
  };
  const head = (table: string) => db.from(table).select('*', { count: 'exact', head: true });
  const docIds = ids.documents.map((d) => d.id);
  const anonIds = ids.anonymizedCvs.map((a) => a.id);
  const sendsFilter = [`candidate_id.eq.${candidateId}`, anonIds.length ? `anonymized_cv_id.in.(${anonIds.join(',')})` : '', ids.scores.length ? `score_id.in.(${ids.scores.join(',')})` : ''].filter(Boolean).join(',');
  const [candidates, documents, verifications, anonymized_cvs, sends, scores, candidate_placements, campaign_candidates, internal_downloads] = await Promise.all([
    n('candidates', head('candidates').eq('id', candidateId)),
    n('documents', head('documents').eq('candidate_id', candidateId)),
    docIds.length ? n('verifications', head('verifications').in('document_id', docIds)) : Promise.resolve(0),
    n('anonymized_cvs', head('anonymized_cvs').eq('candidate_id', candidateId)),
    n('sends', head('sends').or(sendsFilter)),
    n('scores', head('scores').eq('candidate_id', candidateId)),
    n('candidate_placements', head('candidate_placements').eq('candidate_id', candidateId)),
    n('campaign_candidates', head('campaign_candidates').eq('candidate_id', candidateId)),
    n('internal_downloads', head('internal_downloads').eq('candidate_id', candidateId)),
  ]);
  return { candidates, documents, verifications, anonymized_cvs, sends, scores, candidate_placements, campaign_candidates, internal_downloads };
}

/** Stored files, bucket by bucket. A path that is already gone is not an error; a bucket that refuses is. */
export async function removeFiles(db: SupabaseClient, sets: { bucket: string; paths: (string | null | undefined)[] }[]): Promise<{ removed: Record<string, number>; error?: string }> {
  const removed: Record<string, number> = {};
  // A folder is listed once and read from that: a candidate’s files sit in a handful of folders, and every path is
  // checked twice — before removing, to count only what was really there, and after, to prove it has gone.
  const listing = new Map<string, Set<string>>();
  const namesIn = async (bucket: string, folder: string, fresh = false) => {
    const key = `${bucket}/${folder}`;
    if (!fresh && listing.has(key)) return listing.get(key)!;
    const { data, error } = await db.storage.from(bucket).list(folder);
    if (error) throw new Error(`${bucket}: the files in ${folder || "the bucket root"} could not be listed: ${error.message}`);
    const names = new Set((data ?? []).map((o: any) => o.name as string));
    listing.set(key, names);
    return names;
  };
  const split = (path: string) => { const cut = path.lastIndexOf('/'); return { folder: cut < 0 ? '' : path.slice(0, cut), name: cut < 0 ? path : path.slice(cut + 1) }; };

  try {
    for (const s of sets) {
      const paths = [...new Set(s.paths.filter((p): p is string => !!p))];
      removed[s.bucket] = removed[s.bucket] ?? 0;
      // Only the ones that are actually stored: the caller asks for a screenshot path per document, and most have none.
      const there: string[] = [];
      for (const path of paths) {
        const { folder, name } = split(path);
        if ((await namesIn(s.bucket, folder)).has(name)) there.push(path);
      }
      if (there.length === 0) continue;
      for (let i = 0; i < there.length; i += 100) {
        const { error } = await db.storage.from(s.bucket).remove(there.slice(i, i + 100));
        if (error) return { removed, error: `${s.bucket}: ${error.message}` };
      }
      // remove() answers with the paths it was asked about, not the ones it deleted, so its answer proves nothing: on
      // 2026-09-16 a delete reported four files erased and all four were still stored. Each one is looked for again.
      for (const path of there) {
        const { folder, name } = split(path);
        if ((await namesIn(s.bucket, folder, true)).has(name)) return { removed, error: `${s.bucket}/${path} is still stored after being removed` };
        removed[s.bucket] += 1;
      }
    }
  } catch (e: any) {
    return { removed, error: String(e?.message ?? e) };
  }
  return { removed };
}

/**
 * Is 0037's delete function in the database? Called with ids that exist nowhere: the function refuses an unknown candidate
 * ("no candidate …"); a database without it answers that there is no such function. Asked before anything is deleted.
 */
export async function deleteFunctionReady(db: SupabaseClient): Promise<boolean> {
  const nobody = '00000000-0000-0000-0000-000000000000';
  const { error } = await db.rpc('delete_candidate_rows', { p_candidate: nobody, p_workspace: nobody });
  return !!error && /no candidate/i.test(error.message);
}

/** The files a candidate's documents and client versions keep in storage. */
export function candidateFiles(workspaceId: string, ids: CandidateIds) {
  return [
    { bucket: 'documents', paths: ids.documents.map((d) => d.storage_path) },
    { bucket: 'screenshots', paths: ids.documents.map((d) => `${workspaceId}/verify/${d.id}.png`) },
    { bucket: 'pdfs', paths: ids.anonymizedCvs.map((a) => a.storage_path) },
  ];
}
