import type { SupabaseClient } from '@supabase/supabase-js';
import { fold, matches, parseQuery, type Node } from './candidate-search';
import { candidateNumber } from './candidate-number';
import { sendKind, sendSearchText, type SendKind } from './cv-sent-entry';
import { STAGES, STAGE_LABEL, PREFERENCES, PREFERENCE_LABEL, type Stage, type Preference } from './candidate-stages';
import { lapsedCerts } from './cert-availability';
export { STAGES, STAGE_LABEL, PREFERENCES, PREFERENCE_LABEL, type Stage, type Preference } from './candidate-stages';

/**
 * The candidate pool as the list and the kanban read it (item 24). SENSITIVE PERSONAL DATA — read with the signed-in
 * user's client, so row-level security decides what comes back.
 *
 * Four reads of what the screens show and search — candidates, their certificates, CVs sent, placements — each paged
 * 1,000 rows at a time (one unpaged read stops at 1,000) and joined in memory, never the parsed profile, which is the
 * heavy part of a candidate. Each row gets one
 * folded text the boolean search runs over: number, reference code, name, trade, where they are based, nationality,
 * stage, employment preference, availability, notes, certificates (body, level, number), every client a CV was sent to
 * ("sent to …"), every pack prepared for a lead ("pack for …" — no sent date, so never "sent to"; cv-sent-entry.ts) and
 * every placement ("placed at …", "currently placed at …" while it has no end date).
 */

export type PoolCertificate = { body: string | null; level: string | null; number: string | null; validUntil: string | null; state: string | null };
export type PoolRow = {
  id: string; reference: string | null; number: number | null; name: string | null; trade: string | null;
  country: string | null; nationality: string | null; stage: Stage; preference: Preference | null;
  availableFrom: string | null; ownerId: string | null; createdBy: string | null; createdAt: string; notes: string | null;
  certificates: PoolCertificate[];
  /**
   * One line per certificate body whose every copy has run out — "CSWIP expired 2026-08-15".
   *
   * Computed on read like lead age and compound signals, never stored: candidates.availability_from is
   * a date meaning "free from", not a flag, and writing a lapsed certificate into it would assert
   * something different and false and overwrite a real date. Deliberately NOT called "unavailable":
   * that is only true of a role that asks for the certificate, and no role is in view on this list.
   */
  lapsed: string[];
  sentTo: { client: string; sentAt: string | null; kind: SendKind }[];
  placements: { client: string; placedOn: string; endedOn: string | null }[];
  haystack: string;
};

const PAGE = 1000;

type Narrow = (q: any) => any;

/** Every row of one table the user may read, paged 1,000 at a time with every page requested at once, ordered by id. */
async function pagedAll(sb: SupabaseClient, table: string, cols: string, narrow: Narrow = (q) => q): Promise<{ data: any[]; error: string | null }> {
  const { count, error: countError } = await narrow(sb.from(table).select('id', { count: 'exact', head: true }));
  if (countError) return { data: [], error: `${table}: ${countError.message}` };
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE));
  const results = await Promise.all(Array.from({ length: pages }, (_, i) =>
    narrow(sb.from(table).select(cols)).order('id').range(i * PAGE, i * PAGE + PAGE - 1)));
  const failed = results.find((r: any) => r.error);
  if (failed) return { data: [], error: `${table}: ${failed.error.message}` };
  return { data: results.flatMap((r: any) => r.data ?? []), error: null };
}

export async function loadPool(sb: SupabaseClient, crm: boolean): Promise<{ rows: PoolRow[]; error: string | null; ms: number }> {
  const t0 = Date.now();
  // Owner's decision 2026-09-15 (option 1): four flat reads joined here, not one read with the certificates, CVs sent and
  // placements embedded under each candidate. At 2,500 candidates the embedded read took 4.8 s and this 1.7 s; a stored
  // search column (about 0.3 s) was turned down because a trigger that misses a case leaves the list silently stale.
  // Revisit only if the real pool nears 2,500. Each read is the signed-in user's, so row-level security still decides.
  const [cands, docs, sends, placements] = await Promise.all([
    pagedAll(sb, 'candidates', [
      'id, reference_code, full_name, trade, nationality, availability_from, created_by, created_at, internal_notes',
      crm ? 'stage, employment_preference, country, owner_id' : '',
    ].filter(Boolean).join(', ')),
    pagedAll(sb, 'documents', 'candidate_id, type, cert_body, level:extracted->>level, number:extracted->>number, verifications(valid_until, state, checked_at)',
      (q) => q.eq('type', 'certificate').not('candidate_id', 'is', null)),
    pagedAll(sb, 'sends', `candidate_id, sent_at, ${crm ? 'client_name, ' : ''}companies(name)`),
    crm ? pagedAll(sb, 'candidate_placements', 'candidate_id, client_name, placed_on, ended_on') : Promise.resolve({ data: [], error: null }),
  ]);
  // A part that could not be read fails the whole list: a pool shown without its certificates or placements would search
  // as if nobody held one.
  const failed = [cands, docs, sends, placements].find((r) => r.error);
  if (failed) return { rows: [], error: failed.error, ms: Date.now() - t0 };
  const byCandidate = (rows: any[]) => {
    const m = new Map<string, any[]>();
    for (const r of rows) { const list = m.get(r.candidate_id); if (list) list.push(r); else m.set(r.candidate_id, [r]); }
    return m;
  };
  const docsOf = byCandidate(docs.data), sendsOf = byCandidate(sends.data), placementsOf = byCandidate(placements.data);
  const raw = [...cands.data]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(a.id).localeCompare(String(b.id)))
    .map((c) => ({ ...c, documents: docsOf.get(c.id) ?? [], sends: sendsOf.get(c.id) ?? [], candidate_placements: placementsOf.get(c.id) ?? [] }));
  // `raw.map(toRow)` would hand toRow the array INDEX as its second argument, which is now the clock.
  const now = new Date();
  return { rows: raw.map((c) => toRow(c, now)), error: null, ms: Date.now() - t0 };
}

function toRow(c: any, now = new Date()): PoolRow {
  const certificates: PoolCertificate[] = (c.documents ?? []).filter((d: any) => d.type === 'certificate').map((d: any) => {
    const v = [...(d.verifications ?? [])].sort((a: any, b: any) => String(b.checked_at ?? '').localeCompare(String(a.checked_at ?? '')))[0];
    return { body: d.cert_body ?? null, level: d.level ?? null, number: d.number ?? null, validUntil: v?.valid_until ?? null, state: v?.state ?? null };
  });
  const sentTo: PoolRow['sentTo'] = (c.sends ?? []).map((s: any) => ({ client: String(s.client_name ?? s.companies?.name ?? '').trim(), sentAt: s.sent_at ?? null, kind: sendKind(s.sent_at) })).filter((s: any) => s.client);
  const placements: PoolRow['placements'] = (c.candidate_placements ?? []).map((p: any) => ({ client: String(p.client_name ?? '').trim(), placedOn: p.placed_on, endedOn: p.ended_on ?? null })).filter((p: any) => p.client);
  const stage: Stage = (STAGES as readonly string[]).includes(c.stage) ? c.stage : 'new';
  const preference: Preference | null = (PREFERENCES as readonly string[]).includes(c.employment_preference) ? c.employment_preference : null;
  const number = candidateNumber(c.reference_code);
  const lapsed = lapsedCerts(certificates, now);
  const haystack = fold([
    number !== null ? `#${number}` : '', c.reference_code, c.full_name, c.trade, c.country, c.nationality,
    STAGE_LABEL[stage], preference ? PREFERENCE_LABEL[preference] : '', c.availability_from ? `available ${c.availability_from}` : '',
    c.internal_notes,
    // The designation as a recruiter writes it — "CSWIP 3.1", "FROSIO III" — and as the certificate words it ("level 3.1").
    // The first version wrote "cswip level 3.1 3.1", so the phrase "cswip 3.1" matched nobody (candidate-pool-scale, 2,500 candidates).
    ...certificates.map((x) => [x.body && x.level ? `${x.body} ${x.level}` : x.body, x.level ? `level ${x.level}` : '', x.number].filter(Boolean).join(' · ')),
    // A lapsed certificate is searchable in the words a recruiter would use — "expired", "expired
    // cswip" — because the reason to look for one is usually that a client has just asked.
    ...lapsed.map((l) => `${l} expired certificate`),
    ...sentTo.map((s) => sendSearchText(s.client, s.sentAt)),
    ...placements.map((p) => `placed at ${p.client}${p.endedOn ? '' : ` currently placed at ${p.client}`}`),
  ].filter(Boolean).join(' | '));
  return {
    id: c.id, reference: c.reference_code ?? null, number, name: c.full_name ?? null, trade: c.trade ?? null,
    country: c.country ?? null, nationality: c.nationality ?? null, stage, preference,
    availableFrom: c.availability_from ?? null, ownerId: c.owner_id ?? null, createdBy: c.created_by ?? null, createdAt: c.created_at,
    notes: c.internal_notes ?? null, certificates, lapsed, sentTo, placements, haystack,
  };
}

export type PoolFilter = { q?: string; mine?: boolean; stage?: string; preference?: string };

/** Search and filter the loaded pool. A query that cannot be read comes back as an error, never as an empty list. */
export function filterPool(rows: PoolRow[], f: PoolFilter, me: { id: string }): { rows: PoolRow[]; error: string | null; query: Node | null; ms: number } {
  const t0 = performance.now();
  const parsed = parseQuery(f.q ?? '');
  if (!parsed.ok) return { rows: [], error: parsed.error, query: null, ms: performance.now() - t0 };
  const out = rows.filter((r) =>
    (!f.mine || (r.ownerId ?? r.createdBy) === me.id)
    && (!f.stage || r.stage === f.stage)
    && (!f.preference || r.preference === f.preference)
    && matches(parsed.node, r.haystack));
  return { rows: out, error: null, query: parsed.node, ms: performance.now() - t0 };
}
