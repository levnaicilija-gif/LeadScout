import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * What a recruiter still owes somebody (Today, 2026-09-17).
 *
 * Derived, never stored: a pack or an outreach that has had no reply for three days, and a screening
 * answer the recruiter marked "unclear" and has not gone back to. There is no follow-up row to tick,
 * which is why resolving one is its own record (0042, followup_resolutions) keyed on kind plus the id
 * of the thing it was about.
 *
 * Resolving never deletes or hides (owner's decision): the resolution stays on the candidate's own
 * activity history, and only stops the item appearing in the active list.
 *
 * Deliberately NOT duplicated from Today's queue. The queue says what to read; this says what YOU
 * have left hanging.
 */

export type FollowupKind = 'no_reply' | 'unclear_answer';

export type Followup = {
  kind: FollowupKind;
  /** The row this was derived from — an outreach id, or a screening answer id. */
  sourceId: string;
  candidateId: string | null;
  /** Who it is about, as a recruiter would say it. */
  who: string;
  /** What is outstanding, in one line. */
  what: string;
  /** The measurable fact behind it — "no response, 3 days", "still \"unclear\"". */
  detail: string;
  /** When the clock started, so the list can sort oldest first. */
  since: string | null;
};

export type FollowupState = {
  active: Followup[];
  /** Already dealt with, kept for the candidate's history. */
  resolved: (Followup & { resolvedAt: string; note: string | null })[];
  /** Set when something could not be read, so an empty list is never mistaken for nothing owed. */
  error: string | null;
};

const DAYS = 86400000;
const ago = (n: number) => new Date(Date.now() - n * DAYS).toISOString();

/** How many whole days since a timestamp. */
export const daysSince = (iso: string | null | undefined) =>
  iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / DAYS)) : null;

/**
 * Every follow-up outstanding for this workspace, and the ones already resolved.
 *
 * Read with the caller's own client, so row-level security decides what is visible. A read that
 * fails returns its message rather than an empty list: a screen must never report an absence it did
 * not check (CLAUDE.md).
 */
export async function followups(sb: SupabaseClient, opts: { resolutionsReady: boolean }): Promise<FollowupState> {
  const problems: string[] = [];

  // 1. Outreach sent three days ago or more with no reply. Today's queue shows these as work to do;
  //    here they are a debt, and can be marked done without chasing.
  const noReply = await sb.from('outreach')
    .select('id, sent_at, lead_id, leads(project_name, companies(name))')
    .eq('status', 'sent').is('reply_at', null).lte('sent_at', ago(3))
    .order('sent_at', { ascending: true }).limit(50);
  if (noReply.error) problems.push(`outreach with no reply could not be read: ${noReply.error.message}`);

  // 2. A screening answer the recruiter marked "unclear". It has no candidate of its own — it reaches
  //    a person only through its call (0040) — so the join goes through screening_calls.
  const unclear = await sb.from('screening_answers')
    .select('id, question, answered_at, screening_calls!inner(candidate_id, workspace_id, candidates!candidate_id(reference_code, full_name))')
    .eq('verdict', 'unclear')
    .order('answered_at', { ascending: true }).limit(50);
  // 0040 may not be applied; that is not a failure to report to a recruiter.
  if (unclear.error && !/schema cache|does not exist/i.test(unclear.error.message)) {
    problems.push(`screening answers could not be read: ${unclear.error.message}`);
  }

  const all: Followup[] = [];
  for (const o of noReply.data ?? []) {
    const l: any = (o as any).leads;
    const n = daysSince(o.sent_at);
    all.push({
      kind: 'no_reply',
      sourceId: o.id,
      candidateId: null,
      who: l?.companies?.name ?? 'a contact',
      what: l?.project_name ? `outreach about ${l.project_name}` : 'outreach sent',
      detail: n === null ? 'no reply' : `no response, ${n} day${n === 1 ? '' : 's'}`,
      since: o.sent_at ?? null,
    });
  }
  for (const a of (unclear.data ?? []) as any[]) {
    const c = a.screening_calls?.candidates;
    all.push({
      kind: 'unclear_answer',
      sourceId: a.id,
      candidateId: a.screening_calls?.candidate_id ?? null,
      who: c?.full_name ?? c?.reference_code ?? 'a candidate',
      what: a.question ? `answer to "${String(a.question).slice(0, 60)}"` : 'a screening answer',
      detail: 'still "unclear"',
      since: a.answered_at ?? null,
    });
  }

  // 3. Anything already dealt with drops out of the active list and into the history.
  if (!opts.resolutionsReady) {
    return { active: all, resolved: [], error: problems.join('; ') || null };
  }
  const done = await sb.from('followup_resolutions').select('kind, source_id, note, resolved_at');
  if (done.error) {
    problems.push(`resolved follow-ups could not be read: ${done.error.message}`);
    return { active: all, resolved: [], error: problems.join('; ') };
  }
  const key = (k: string, id: string) => `${k}:${id}`;
  const byKey = new Map((done.data ?? []).map((r: any) => [key(r.kind, r.source_id), r]));

  const active: Followup[] = [];
  const resolved: FollowupState['resolved'] = [];
  for (const f of all) {
    const hit = byKey.get(key(f.kind, f.sourceId));
    if (hit) resolved.push({ ...f, resolvedAt: hit.resolved_at, note: hit.note ?? null });
    else active.push(f);
  }
  // Oldest debt first: the thing that has been waiting longest is the thing to do.
  active.sort((a, b) => String(a.since ?? '9999').localeCompare(String(b.since ?? '9999')));
  resolved.sort((a, b) => String(b.resolvedAt).localeCompare(String(a.resolvedAt)));

  return { active, resolved, error: problems.join('; ') || null };
}
