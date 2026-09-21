import Link from 'next/link';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { followedIndustries } from '@/lib/industry-follow';
import { todayItems, whenLabel } from '@/lib/today';
import { hasScorecards, hasSendsCreatedAt, hasFollowupResolutions, hasLastSeen } from '@/lib/schema-features';
import { countsFor, LABELS, type CountKey } from '@/lib/scorecard';
import { followups } from '@/lib/followups';
import { FollowupList } from '@/components/FollowupList';
import { visitWindow } from '@/lib/visit';
export const dynamic = 'force-dynamic';

/**
 * Yesterday and today's queue in full — what Today's Yesterday card opens (2026-09-17).
 *
 * Three things a card has no room for: yesterday's counts as item 11 step 3 built them, the
 * follow-ups a recruiter still owes somebody with a way to mark one done, and the whole queue rather
 * than its first three rows.
 *
 * A resolved follow-up stays on this page under Resolved, and on the candidate's own history. It is
 * never deleted and never hidden — it only leaves the active list (owner's decision).
 */
export default async function YesterdayAndQueue() {
  const me = await currentUser();
  const sb = supabaseServer();
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);

  const scorecardsOn = await hasScorecards(sb);
  const followupsOn = await hasFollowupResolutions(sb);
  const sendsDated = await hasSendsCreatedAt(sb);
  // Read once so the guard is warm for the queue below — and used, so this page windows its queue
  // exactly as Today and Home do rather than quietly showing a different list.
  const lastSeenOn = await hasLastSeen(sb);
  const visit = visitWindow(lastSeenOn ? (me as any)?.last_seen_at ?? null : null, new Date());
  const windowSince = lastSeenOn && visit.since && visit.advance ? visit.since : null;

  const [items, state, counts] = await Promise.all([
    todayItems(sb, followedIndustries((me as any)?.industry_follow), windowSince),
    followups(sb, { resolutionsReady: followupsOn }),
    scorecardsOn && me
      ? countsFor(sb, { workspaceId: me.workspace_id, userId: me.id, day: yesterday, sendsHasCreatedAt: sendsDated })
      : Promise.resolve(null),
  ]);

  const day = (s: string) => new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

  return (<>
    <Link href="/app/today" className="mb-4 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-accent">← Back to Today</Link>
    <h1 className="font-display text-[22px] font-extrabold tracking-[-.02em]">Yesterday &amp; today&apos;s queue</h1>
    <div className="mb-5 text-[12.5px] text-ink3">{day(yesterday)} – {day(now.toISOString())}</div>

    <section className="mb-4 rounded-card border border-line bg-panel p-5">
      <h2 className="text-[16px] font-bold">Yesterday&apos;s activity</h2>
      <div className="mb-4 text-[12.5px] text-ink2">{day(yesterday)} — counts only{counts && !Object.values(counts.counts).some((n) => n > 0) ? ', nothing recorded' : ''}</div>
      {!counts
        ? <div className="text-[12.5px] text-ink3">The scorecard tables are not in the database yet (migration 0039).</div>
        : (<>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {(Object.keys(LABELS) as CountKey[]).map((k) => (
              <div key={k} data-stat={k} className="rounded-[10px] bg-bg px-3.5 py-3">
                <b className={`block text-[20px] font-extrabold ${counts.counts[k] > 0 ? 'text-accent' : 'text-ink3'}`}>{counts.counts[k]}</b>
                <span className="text-[10.5px] text-ink3">{LABELS[k]}{k === 'verifications' ? '*' : ''}</span>
              </div>
            ))}
          </div>
          {counts.caveats.verifications && <div className="mt-2 text-[10.5px] text-ink3">*{counts.caveats.verifications}</div>}
        </>)}
    </section>

    <section className="mb-4 rounded-card border border-line bg-panel p-5">
      <h2 className="text-[16px] font-bold">Needs your follow-up</h2>
      <div className="mb-4 text-[12.5px] text-ink2">Not duplicated from the queue below — this is what you need to chase. Marking one done keeps it in that candidate&apos;s own history; it just stops showing here.</div>
      {state.error && <div className="mb-2 text-[12.5px] text-bad">Some follow-ups could not be read: {state.error}. This list is incomplete, not empty.</div>}
      <FollowupList
        ready={followupsOn}
        active={state.active.map((f) => ({ kind: f.kind, sourceId: f.sourceId, candidateId: f.candidateId, who: f.who, what: f.what, detail: f.detail, since: f.since }))}
      />
    </section>

    {state.resolved.length > 0 && (
      <section data-resolved-panel className="mb-4 rounded-card border border-line bg-panel p-5">
        <h2 className="text-[16px] font-bold">Resolved</h2>
        <div className="mb-4 text-[12.5px] text-ink2">Kept here and on the candidate&apos;s own activity history — never deleted</div>
        {state.resolved.map((f) => (
          <div key={`${f.kind}:${f.sourceId}`} data-resolved={`${f.kind}:${f.sourceId}`} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line2 py-2 text-[12.5px] last:border-0">
            <span><b className="font-semibold">{f.who}</b> <span className="text-ink2">— {f.what}</span>{f.note ? <span className="text-ink2"> · {f.note}</span> : ''}</span>
            <span className="text-[12px] text-ok">done {new Date(f.resolvedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
          </div>
        ))}
      </section>
    )}

    <section className="rounded-card border border-line bg-panel p-5">
      <h2 className="text-[16px] font-bold">Today&apos;s queue, in full</h2>
      <div className="mb-4 text-[12.5px] text-ink2">A clock time only where a call is actually scheduled</div>
      {items.length === 0 && <div className="text-[12.5px] text-ink3">Nothing yet. Radar reads your sources every morning.</div>}
      {items.map((it, i) => (
        <div key={i} data-queue-item={i} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line2 py-2 text-[12.5px] last:border-0">
          <Link href={it.href} className="text-ink2 hover:text-ink">{i + 1} · {it.title}</Link>
          <span className="text-ink3">{it.when ? new Date(it.when).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : whenLabel(it, i)}</span>
        </div>
      ))}
    </section>
  </>);
}
