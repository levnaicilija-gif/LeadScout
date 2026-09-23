import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { hasColumn } from '@/lib/schema-features';

/**
 * "This is the same file you already have, on #N."
 *
 * The one duplicate signal with no judgement in it. Item 24's rule compares a NAME plus a second
 * field, which is right for "is this the same person" and cannot answer "is this the same file" —
 * and on 2026-09-22 the same CV dropped twice, 85 seconds apart, became two candidate records. Both
 * copies were byte for byte identical. Nothing in the app could see that, because the digest in a
 * storage path is of the FILE NAME (storage-path.ts), never of the bytes: re-saving the same CV
 * under a different name produced a different path, and saving it under the same name produced the
 * same path for a different candidate.
 *
 * A HASH IS EVIDENCE OF A FILE, NEVER OF A PERSON. Two people can hold the same document — a blank
 * template, a scanned form, an agency's covering CV — so a match is something to ASK about, exactly
 * like a name match, and never something to merge on. It is stronger than a name match only in that
 * it cannot be a coincidence of spelling.
 *
 * NULL IS NOT A VALUE HERE. Rows written before 0044 carry no hash, and a missing hash means "never
 * hashed", never "different from everything". Every comparison below refuses null on both sides,
 * because the alternative — treating absence as difference — is the same mistake as reading a failed
 * pool read as an empty pool, which is what this whole item is about.
 */

export const contentHash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export type HashMatch = {
  documentId: string;
  candidateId: string | null;
  reference: string | null;
  name: string | null;
  type: string | null;
  uploadedAt: string | null;
};

/**
 * Documents in this workspace whose stored bytes are the same file.
 *
 * Returns `{ supported: false }` where 0044 is not applied yet, so a caller can tell "no duplicates"
 * apart from "this database cannot answer that question" — the distinction the pool read got wrong.
 */
export async function sameFileInWorkspace(
  db: SupabaseClient,
  workspaceId: string,
  hash: string | null,
): Promise<{ supported: boolean; matches: HashMatch[]; error: string | null }> {
  if (!hash) return { supported: true, matches: [], error: null };
  if (!(await hasColumn(db, 'documents', 'content_sha256'))) return { supported: false, matches: [], error: null };

  const { data, error } = await db.from('documents')
    .select('id, candidate_id, type, uploaded_at, candidates!candidate_id(reference_code, full_name)')
    .eq('workspace_id', workspaceId)
    .eq('content_sha256', hash);
  // Read the error. A failed lookup is not "no duplicate" — the caller decides what to do, but it
  // must not be told there was nothing there.
  if (error) return { supported: true, matches: [], error: error.message };

  return {
    supported: true,
    error: null,
    matches: (data ?? []).map((d: any) => ({
      documentId: d.id,
      candidateId: d.candidate_id ?? null,
      reference: d.candidates?.reference_code ?? null,
      name: d.candidates?.full_name ?? null,
      type: d.type ?? null,
      uploadedAt: d.uploaded_at ?? null,
    })),
  };
}

/** The sentence shown when the same file is already on somebody. */
export function sameFileNote(matches: HashMatch[]): string | null {
  const onSomebody = matches.filter((m) => m.candidateId);
  if (!onSomebody.length) return null;
  const who = onSomebody
    .map((m) => `${m.reference ?? 'a record with no reference'}${m.name ? ` (${m.name})` : ''}`)
    .filter((v, i, a) => a.indexOf(v) === i);
  return who.length === 1
    ? `This is the same file, byte for byte, as one already on ${who[0]}.`
    : `This is the same file, byte for byte, as ones already on ${who.join(' and ')}.`;
}
