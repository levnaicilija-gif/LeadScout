import type { SupabaseClient } from '@supabase/supabase-js';
import { fold, matches, parseQuery, type Node } from './candidate-search';
import { candidateNumber } from './candidate-number';
import { STAGES, STAGE_LABEL, PREFERENCES, PREFERENCE_LABEL, type Stage, type Preference } from './candidate-stages';
export { STAGES, STAGE_LABEL, PREFERENCES, PREFERENCE_LABEL, type Stage, type Preference } from './candidate-stages';

/**
 * The candidate pool as the list and the kanban read it (item 24). SENSITIVE PERSONAL DATA — read with the signed-in
 * user's client, so row-level security decides what comes back.
 *
 * One read of what the screens show and search, paged 1,000 rows at a time (one unpaged read stops at 1,000 — cost_log
 * found that on 10 September), never the parsed profile, which is the heavy part of a candidate. Each row gets one
 * folded text the boolean search runs over: number, reference code, name, trade, where they are based, nationality,
 * stage, employment preference, availability, notes, certificates (body, level, number), every client a CV was sent to
 * ("sent to …") and every placement ("placed at …", "currently placed at …" while it has no end date).
 */

export type PoolCertificate = { body: string | null; level: string | null; number: string | null; validUntil: string | null; state: string | null };
export type PoolRow = {
  id: string; reference: string | null; number: number | null; name: string | null; trade: string | null;
  country: string | null; nationality: string | null; stage: Stage; preference: Preference | null;
  availableFrom: string | null; ownerId: string | null; createdBy: string | null; createdAt: string; notes: string | null;
  certificates: PoolCertificate[];
  sentTo: { client: string; sentAt: string | null }[];
  placements: { client: string; placedOn: string; endedOn: string | null }[];
  haystack: string;
};

const PAGE = 1000;

export async function loadPool(sb: SupabaseClient, crm: boolean): Promise<{ rows: PoolRow[]; error: string | null; ms: number }> {
  const t0 = Date.now();
  const cols = [
    'id, reference_code, full_name, trade, nationality, availability_from, created_by, created_at, internal_notes',
    crm ? 'stage, employment_preference, country, owner_id' : '',
    'documents!candidate_id(type, cert_body, level:extracted->>level, number:extracted->>number, verifications(valid_until, state, checked_at))',
    `sends(sent_at, ${crm ? 'client_name, ' : ''}companies(name))`,
    crm ? 'candidate_placements(client_name, placed_on, ended_on)' : '',
  ].filter(Boolean).join(', ');
  // Count first, then every page at once: read one after another, 2,500 candidates took 5.1–5.5 s signed in.
  const { count, error: countError } = await sb.from('candidates').select('id', { count: 'exact', head: true });
  if (countError) return { rows: [], error: countError.message, ms: Date.now() - t0 };
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE));
  const results = await Promise.all(Array.from({ length: pages }, (_, i) =>
    sb.from('candidates').select(cols as '*').order('created_at', { ascending: false }).order('id').range(i * PAGE, i * PAGE + PAGE - 1)));
  const failed = results.find((r) => r.error);
  if (failed?.error) return { rows: [], error: failed.error.message, ms: Date.now() - t0 };
  const raw: any[] = results.flatMap((r) => r.data ?? []);
  return { rows: raw.map(toRow), error: null, ms: Date.now() - t0 };
}

function toRow(c: any): PoolRow {
  const certificates: PoolCertificate[] = (c.documents ?? []).filter((d: any) => d.type === 'certificate').map((d: any) => {
    const v = [...(d.verifications ?? [])].sort((a: any, b: any) => String(b.checked_at ?? '').localeCompare(String(a.checked_at ?? '')))[0];
    return { body: d.cert_body ?? null, level: d.level ?? null, number: d.number ?? null, validUntil: v?.valid_until ?? null, state: v?.state ?? null };
  });
  const sentTo: PoolRow['sentTo'] = (c.sends ?? []).map((s: any) => ({ client: String(s.client_name ?? s.companies?.name ?? '').trim(), sentAt: s.sent_at ?? null })).filter((s: any) => s.client);
  const placements: PoolRow['placements'] = (c.candidate_placements ?? []).map((p: any) => ({ client: String(p.client_name ?? '').trim(), placedOn: p.placed_on, endedOn: p.ended_on ?? null })).filter((p: any) => p.client);
  const stage: Stage = (STAGES as readonly string[]).includes(c.stage) ? c.stage : 'new';
  const preference: Preference | null = (PREFERENCES as readonly string[]).includes(c.employment_preference) ? c.employment_preference : null;
  const number = candidateNumber(c.reference_code);
  const haystack = fold([
    number !== null ? `#${number}` : '', c.reference_code, c.full_name, c.trade, c.country, c.nationality,
    STAGE_LABEL[stage], preference ? PREFERENCE_LABEL[preference] : '', c.availability_from ? `available ${c.availability_from}` : '',
    c.internal_notes,
    // The designation as a recruiter writes it — "CSWIP 3.1", "FROSIO III" — and as the certificate words it ("level 3.1").
    // The first version wrote "cswip level 3.1 3.1", so the phrase "cswip 3.1" matched nobody (candidate-pool-scale, 2,500 candidates).
    ...certificates.map((x) => [x.body && x.level ? `${x.body} ${x.level}` : x.body, x.level ? `level ${x.level}` : '', x.number].filter(Boolean).join(' · ')),
    ...sentTo.map((s) => `sent to ${s.client}`),
    ...placements.map((p) => `placed at ${p.client}${p.endedOn ? '' : ` currently placed at ${p.client}`}`),
  ].filter(Boolean).join(' | '));
  return {
    id: c.id, reference: c.reference_code ?? null, number, name: c.full_name ?? null, trade: c.trade ?? null,
    country: c.country ?? null, nationality: c.nationality ?? null, stage, preference,
    availableFrom: c.availability_from ?? null, ownerId: c.owner_id ?? null, createdBy: c.created_by ?? null, createdAt: c.created_at,
    notes: c.internal_notes ?? null, certificates, sentTo, placements, haystack,
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
