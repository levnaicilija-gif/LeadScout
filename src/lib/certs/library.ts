import type { SupabaseClient } from '@supabase/supabase-js';
import type { LibraryRow } from './explain';

/**
 * Reading and writing the certificate library.
 *
 * The uniqueness in 0019 is two partial indexes — one for the shipped rows, one per workspace —
 * because "shipped" is `workspace_id is null` and a plain unique index cannot express that.
 * Postgres will not use a partial expression index to back an ON CONFLICT, so every write here
 * reads first and then inserts or updates. It is one extra round trip and it keeps the schema
 * honest about what is actually unique.
 */

export type WriteInput = {
  workspaceId: string | null;
  body: string;
  level?: string | null;
  lang?: string;
  patch: Record<string, any>;
  userId?: string | null;
};

const key = (r: any) => `${String(r.body).toLowerCase()}|${(r.level ?? '').toLowerCase()}|${r.lang ?? 'en'}`;

/** Every row that could explain any of these bodies: the workspace's own, and the shipped ones. */
export async function loadLibrary(db: SupabaseClient, workspaceId: string | null, bodies: string[]): Promise<LibraryRow[]> {
  const want = [...new Set(bodies.map((b) => String(b ?? '').toLowerCase().trim()).filter(Boolean))];
  if (!want.length) return [];
  let q = db.from('cert_library').select('*').in('body', want);
  // `or` keeps both halves in one request; a workspace only ever sees its own rows and ours.
  q = workspaceId ? q.or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`) : q.is('workspace_id', null);
  const { data, error } = await q;
  if (error) return [];
  return (data ?? []) as LibraryRow[];
}

/** Insert or update one entry, scoped to a workspace or to the shipped set. */
export async function writeEntry(db: SupabaseClient, input: WriteInput) {
  const lang = input.lang ?? 'en';
  const body = String(input.body).toLowerCase().trim();
  const level = input.level ?? null;

  let find = db.from('cert_library').select('id').eq('body', body).eq('lang', lang);
  find = level === null ? find.is('level', null) : find.eq('level', level);
  find = input.workspaceId === null ? find.is('workspace_id', null) : find.eq('workspace_id', input.workspaceId);
  const { data: existing } = await find.maybeSingle();

  const row = {
    ...input.patch,
    workspace_id: input.workspaceId,
    body, level, lang,
    updated_by: input.userId ?? null,
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) return db.from('cert_library').update(row).eq('id', existing.id).select().single();
  return db.from('cert_library').insert(row).select().single();
}

/**
 * Record that a certificate arrived that nothing can explain.
 *
 * One row per body and level, counted — ten copies of the same unknown ticket are one job of
 * work for a senior and not ten. Never throws: an unrecognised certificate must still render.
 */
export async function noteUnknown(db: SupabaseClient, input: { workspaceId: string; body: string; level?: string | null; documentId?: string | null }) {
  try {
    const body = String(input.body ?? '').toLowerCase().trim();
    if (!body) return;
    let find = db.from('cert_unknown').select('id, seen_count').eq('workspace_id', input.workspaceId).eq('body', body);
    find = input.level ? find.eq('level', input.level) : find.is('level', null);
    const { data: seen } = await find.maybeSingle();
    if (seen?.id) {
      await db.from('cert_unknown').update({ seen_count: (seen.seen_count ?? 1) + 1, last_seen_at: new Date().toISOString() }).eq('id', seen.id);
      return;
    }
    await db.from('cert_unknown').insert({
      workspace_id: input.workspaceId, body, level: input.level ?? null,
      example_document_id: input.documentId ?? null,
    });
  } catch { /* explaining a certificate must not fail because the task could not be recorded */ }
}

export { key };
