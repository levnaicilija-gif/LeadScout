import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Item 11 part 3: a recruiter's day, counted from the data rather than typed.
 *
 * Nothing here is stored. Every number is read from the rows that already exist, the way item 19's
 * compound signals are computed on read — so a scorecard can never drift from what the database
 * says, and a row deleted afterwards is simply not counted.
 *
 * The tone rule (owner's decision, 2026-09-16): counts, and a comparison ONLY where a senior has
 * set a real target. "3 of 5" is a fact; "good progress" is editorialising, and a warmth that
 * varies with the numbers teaches people to read the adjective instead of the number. Praise
 * belongs to the senior's own reply; the three lines at the end of the day are the recruiter's own
 * words. Nothing in this file writes a judgement.
 */

export type CountKey = 'packs_prepared' | 'cvs_sent' | 'outreach_sent' | 'verifications' | 'leads_confirmed' | 'candidates_added';

export type Targets = Partial<Record<CountKey, number | null>> | null;

export type Line = {
  key: CountKey;
  label: string;
  n: number;
  /** The senior's target, where one is set. Null means not measured — which is not a target of 0. */
  target: number | null;
  /** What the number is read from, so a recruiter can check it rather than trust it. */
  from: string;
  /** Set where the count cannot be attributed exactly. Shown, never hidden. */
  caveat?: string;
};

export const LABELS: Record<CountKey, string> = {
  packs_prepared: 'Packs prepared',
  cvs_sent: 'CVs sent',
  outreach_sent: 'Outreach sent',
  verifications: 'Verifications',
  leads_confirmed: 'Leads confirmed',
  candidates_added: 'Candidates added',
};

/** The day, as the database stores it: [start, next day) in ISO, so a date column and a timestamp agree. */
export const dayBounds = (day: string) => {
  const from = `${day}T00:00:00.000Z`;
  const to = new Date(Date.parse(from) + 86400000).toISOString();
  return { from, to };
};

/**
 * One line per counted thing, in a fixed order.
 *
 * `target` is null wherever a senior has set nothing, and the screen must then show the count
 * alone — never "0 of 0", which reads as a failure against a target nobody set.
 */
export function lines(counts: Record<CountKey, number>, targets: Targets, caveats: Partial<Record<CountKey, string>> = {}): Line[] {
  return (Object.keys(LABELS) as CountKey[]).map((key) => ({
    key,
    label: LABELS[key],
    n: counts[key] ?? 0,
    target: targets && typeof targets[key] === 'number' ? (targets[key] as number) : null,
    from: FROM[key],
    ...(caveats[key] ? { caveat: caveats[key] } : {}),
  }));
}

const FROM: Record<CountKey, string> = {
  packs_prepared: 'sends prepared for a lead (sent_at empty), by created_at',
  cvs_sent: 'sends logged as sent to a client, by sent_at',
  outreach_sent: 'outreach with a sent_at',
  verifications: 'verifications checked on the day',
  leads_confirmed: 'leads confirmed_at',
  candidates_added: 'candidates created_at',
};

/** "3 of 5" where a target exists, "3" where none does. No adjective, ever. */
export const readLine = (l: Line) => (l.target === null ? `${l.n}` : `${l.n} of ${l.target}`);

/** One plain sentence for a card that has no room for six lines. Counts only. */
export const summary = (ls: Line[]) =>
  ls.map((l) => `${l.label.toLowerCase()} ${readLine(l)}`).join(' · ');

/** Has a senior set anything at all? Decides whether the screen says so. */
export const anyTarget = (targets: Targets) =>
  !!targets && (Object.keys(LABELS) as CountKey[]).some((k) => typeof targets[k] === 'number');

/**
 * The six counts for one person on one day, read with the caller's own client.
 *
 * Attribution is only ever as good as the column behind it, and one of these is not exact:
 * `verifications` has no checked_by and no workspace_id — it hangs off documents — so a check can
 * only be attributed through documents.uploaded_by, which is whoever uploaded the document and not
 * necessarily whoever ran the check. That is said on the screen rather than quietly rounded off.
 */
export async function countsFor(
  sb: SupabaseClient,
  opts: { workspaceId: string; userId: string; day: string; sendsHasCreatedAt: boolean },
): Promise<{ counts: Record<CountKey, number>; caveats: Partial<Record<CountKey, string>>; unavailable: CountKey[] }> {
  const { from, to } = dayBounds(opts.day);
  const n = (r: { count: number | null }) => r.count ?? 0;
  const unavailable: CountKey[] = [];

  // A pack is a sends row with no sent_at. Before 0039 nothing dated it, so it cannot be counted
  // for a day at all — and the screen says that rather than showing a wrong 0.
  const packs = opts.sendsHasCreatedAt
    ? await sb.from('sends').select('id', { count: 'exact', head: true })
        .eq('sent_by', opts.userId).is('sent_at', null).gte('created_at', from).lt('created_at', to)
    : { count: null as number | null };
  if (!opts.sendsHasCreatedAt) unavailable.push('packs_prepared');

  const [cvs, out, vers, leads, cands] = await Promise.all([
    sb.from('sends').select('id', { count: 'exact', head: true })
      .eq('sent_by', opts.userId).not('sent_at', 'is', null).gte('sent_at', from).lt('sent_at', to),
    sb.from('outreach').select('id', { count: 'exact', head: true })
      .eq('sent_by', opts.userId).not('sent_at', 'is', null).gte('sent_at', from).lt('sent_at', to),
    sb.from('verifications').select('id, documents!inner(uploaded_by, workspace_id)', { count: 'exact', head: true })
      .eq('documents.uploaded_by', opts.userId).eq('documents.workspace_id', opts.workspaceId)
      .gte('checked_at', from).lt('checked_at', to),
    sb.from('leads').select('id', { count: 'exact', head: true })
      .eq('workspace_id', opts.workspaceId).eq('confirmed_by', opts.userId).gte('confirmed_at', from).lt('confirmed_at', to),
    sb.from('candidates').select('id', { count: 'exact', head: true })
      .eq('workspace_id', opts.workspaceId).eq('created_by', opts.userId).gte('created_at', from).lt('created_at', to),
  ]);

  return {
    counts: {
      packs_prepared: n(packs as any),
      cvs_sent: n(cvs as any),
      outreach_sent: n(out as any),
      verifications: n(vers as any),
      leads_confirmed: n(leads as any),
      candidates_added: n(cands as any),
    },
    caveats: {
      verifications: 'counted through who uploaded the document — verifications do not record who ran the check',
      ...(opts.sendsHasCreatedAt ? {} : { packs_prepared: 'not countable per day until migration 0039 is applied' }),
    },
    unavailable,
  };
}
