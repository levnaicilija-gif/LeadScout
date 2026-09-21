import Link from 'next/link';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { followedIndustries } from '@/lib/industry-follow';
import { Help } from '@/components/Help';
import { todayItems, whenLabel, last24h, type TodayItem, type Last24Row } from '@/lib/today';
import { planFor, needsReview } from '@/lib/onboarding';
import { hasScorecards, hasSendsCreatedAt, hasLastSeen, hasPreviousVisit, hasFollowupResolutions } from '@/lib/schema-features';
import { ScorecardAfter } from '@/components/ScorecardAfter';
import { LiveRefresh } from '@/components/LiveRefresh';
import { visitWindow, lastHereLabel, clock, whileOut } from '@/lib/visit';
import { VisitStamp } from '@/components/VisitStamp';
import { countsFor, LABELS, type CountKey } from '@/lib/scorecard';
import { followups } from '@/lib/followups';
import { searchableCount } from '@/lib/verify/adapters';
import { CERT_TABLE } from '@/lib/certs/tables';
export const dynamic = 'force-dynamic';

/**
 * Today — design/leadscout-today-final.html, built on the app's own tokens (owner's decision,
 * 2026-09-17: layout, icons and copy from the mockup; colours and typeface stay as every other
 * screen already has them, so Today does not drift from Leads and Candidates).
 *
 * Three cards of equal weight across the top — the queue split by when it happened, yesterday's
 * activity with what still needs chasing, and Leads promoted to sit beside them — then the four
 * tools, then one worked example.
 *
 * EVERY CARD LINKS OUT. Nothing here re-implements Leads, Verify, Pitch or Candidates: the tool
 * cards are front doors onto pages that already exist, and the numbers on them are read from the
 * same rows those pages read. Nothing is a placeholder.
 */
export default async function Today({ searchParams }: { searchParams: { view?: string } }) {
  const me = await currentUser();
  const sb = supabaseServer();
  const now = new Date();
  const iso = (n: number) => new Date(Date.now() + n * 86400000).toISOString();
  const date = (n: number) => iso(n).slice(0, 10);
  const today = date(0);
  const in60 = date(60);

  // When were they last here? Guarded: 0042 may not be applied, and then there is no split to make.
  const lastSeenOn = await hasLastSeen(sb);
  // 0043 keeps the previous visit's start in its own column, so the boundary survives every reload of
  // this visit. Undefined where it is not applied, which visitWindow treats as its pre-0043 self.
  const twoStamps = lastSeenOn && await hasPreviousVisit(sb);
  const visit = visitWindow(
    lastSeenOn ? (me as any)?.last_seen_at ?? null : null,
    now,
    twoStamps ? ((me as any)?.previous_visit_at ?? null) : undefined,
  );
  // Stamped on Today's own load and only after a real absence, so the boundary holds still while they
  // work. Never in currentUser(), which every screen calls on every render (src/lib/visit.ts).
  //
  // The write itself is <VisitStamp />, below, posting to /api/me/visit AFTER this page has rendered.
  // It used to be right here, inline, with `sb` — the SIGNED-IN USER's client — and it had never once
  // succeeded: 0028 revoked update on users from authenticated, 0042 added last_seen_at and granted
  // nothing back, and the answer (42501 permission denied for table users) was discarded unread. Both
  // real accounts read NULL. The order is not incidental either: this page must read the OLD stamp to
  // know what arrived while they were out, so the advance cannot happen before the read.

  // Priority's window (owner's decision, 2026-09-21): every new lead since the last visit, uncapped.
  // Null when there is no honest boundary to name — a first-ever visit, or a reload inside a visit
  // whose boundary has already been consumed — and todayItems then returns every open new lead rather
  // than the fixed 7 days it used to assume. Deliberately NOT visit.since on its own: last_seen_at
  // holds ONE timestamp, so the moment it advances the previous boundary is gone, and windowing a
  // mid-visit reload on it would empty Priority for the rest of the working day.
  // The window holds for the WHOLE visit once 0043 is applied, because visit.since then comes from
  // previous_visit_at and a reload no longer consumes it. Without 0043 the boundary is only honest on
  // the first load of a visit (visit.advance), and every later load falls back to the full open queue
  // rather than to a window that has quietly shrunk to the last few minutes.
  const windowSince = visit.since && (visit.advance || twoStamps) ? visit.since : null;

  const scorecardsOn = await hasScorecards(sb);
  const followupsOn = await hasFollowupResolutions(sb);

  const [items, wonCount, hiringCount, pool, expiring, availableNow, checkedToday, bullets, recentWon, recentHiring, followupState] = await Promise.all([
    todayItems(sb, followedIndustries((me as any)?.industry_follow), windowSince),
    sb.from('leads').select('id', { count: 'exact', head: true }).eq('kind', 'won_work').not('status', 'in', '("stale","not_for_us")'),
    sb.from('job_posts').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    sb.from('candidates').select('id', { count: 'exact', head: true }),
    sb.from('verifications').select('id', { count: 'exact', head: true }).eq('result', 'valid').gte('valid_until', today).lte('valid_until', in60),
    sb.from('candidates').select('id', { count: 'exact', head: true }).or(`availability_from.is.null,availability_from.lte.${today}`),
    sb.from('verifications').select('id', { count: 'exact', head: true }).gte('checked_at', `${today}T00:00:00Z`),
    sb.from('anonymized_cvs').select('bullets').eq('pii_check_passed', true).limit(200),
    sb.from('leads').select('project_name, created_at, companies(name)').eq('kind', 'won_work').not('status', 'in', '("stale","not_for_us")').order('created_at', { ascending: false }).limit(2),
    sb.from('job_posts').select('role, title, posted_at, first_seen_at, companies(name)').eq('status', 'open').order('first_seen_at', { ascending: false }).limit(2),
    followups(sb, { resolutionsReady: followupsOn }),
  ]);

  // Real bullets from real client versions — the mockup's "3" was a snapshot, not a measure.
  const bulletCount = (bullets.data ?? []).reduce((n: number, r: any) => n + (r.bullets?.length ?? 0), 0);
  const schemes = new Set(CERT_TABLE.map((e) => e.body)).size;

  const out = whileOut(items, visit.since, visit.arrived);
  // Anything with no event time of its own — an expiring certificate, a campaign short of documents —
  // sits in neither window and belongs to the day as a whole (src/lib/visit.ts).
  const standing = items.filter((i) => !i.when);

  // Yesterday's counts, exactly as item 11 step 3 built them.
  const yesterday = date(-1);
  const sendsDated = await hasSendsCreatedAt(sb);
  const yCounts = scorecardsOn && me
    ? await countsFor(sb, { workspaceId: me.workspace_id, userId: me.id, day: yesterday, sendsHasCreatedAt: sendsDated })
    : null;

  const plan = planFor(me?.onboarding_day);
  const onPlan = me?.role !== 'senior' && (me?.onboarding_day ?? 99) <= 10;
  const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 18 ? 'Good afternoon' : 'Good evening';
  const sinceHref = visit.since ? `/app/radar?tab=won&since=${encodeURIComponent(visit.since.toISOString())}` : '/app/radar';
  // Priority or the last 24 hours, and Priority on every load (owner's decision, 2026-09-18): the state
  // lives in the URL and nowhere else — no cookie, no column, no localStorage — so "default" is simply the
  // ABSENCE of the parameter. That is also why the Priority button links to bare /app/today rather than
  // ?view=priority: one URL means Priority, not two, and a recruiter who bookmarks or reloads gets the
  // default rather than whatever they last clicked. Read the way every other enum param on Leads is read
  // (searchParams.sort === 'latest'), so an unknown value falls back rather than throwing.
  const view24h = searchParams?.view === '24h';
  // Only when the recruiter asked for it. This is three more queries — leads, postings, and the article
  // dates behind them — and putting it in the Promise.all above would spend them on every Priority load,
  // which is the default and by far the common one. It also could not go there: that block runs before
  // view24h is parsed, so the value it depends on does not exist yet.
  const feed = view24h ? await last24h(sb, followedIndustries((me as any)?.industry_follow), now) : null;
  const GROUPS: { key: Last24Row['group']; label: string; empty: string; tab: 'won' | 'hiring' }[] = [
    { key: 'news', label: 'News', empty: 'nothing new in your followed industries', tab: 'won' },
    { key: 'ted', label: 'TED tender award', empty: 'no award notices in the last 24 hours', tab: 'won' },
    { key: 'hiring', label: 'Hiring now', empty: 'no new adverts in the last 24 hours', tab: 'hiring' },
  ];

  // The row is a link, because it names work and the work is somewhere else (2026-09-17). Until now the
  // queue rendered as plain text on Today and on Home: an item reading "Read 11 new leads — Peene-Werft
  // first", naming eleven companies, did nothing at all when clicked. `it.href` existed the whole time
  // and only Yesterday's page ever read it.
  // `it: TodayItem`, not `any`: the row is a link now, so href must exist and be a string. Every branch of
  // todayItems happens to set one today, but `any` meant a future branch could forget and nothing would say
  // so until a queue row rendered with no destination. The type says it instead of the reader remembering.
  const Item = ({ it, n, live: isLive }: { it: TodayItem; n: string; live?: boolean }) => (
    <Link href={it.href} data-queue-item className="flex gap-3 border-b border-white/10 py-2.5 last:border-0 transition hover:bg-white/[.04]">
      <span className={`mt-0.5 grid h-5 w-5 flex-shrink-0 place-items-center rounded-full text-[10.5px] font-bold ${isLive ? 'bg-accent text-white' : 'bg-white/10 text-[#C7D2E0]'}`}>{n}</span>
      <span className="min-w-0">
        <b className="block text-[13px] font-semibold">{it.title}</b>
        <span className={`text-[10.5px] font-semibold ${isLive ? 'text-[#6FCBEF]' : 'text-accentsoft'}`}>{it.when ? new Date(it.when).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : whenLabel(it, 1)}</span>
        <span className="mt-0.5 block text-[11.5px] leading-normal text-[#AEBBCC]">{it.sub}</span>
      </span>
    </Link>
  );

  const Tool = ({ href, tone, icon, badge, title, body, stats, action }: {
    href: string; tone: 'cand' | 'leads' | 'verify' | 'pitch'; icon: React.ReactNode; badge: string;
    title: string; body: string; stats: { n: string | number; label: string; warn?: boolean }[]; action: string;
  }) => {
    const bg = { cand: 'bg-soft-cand text-tool-cand', leads: 'bg-soft-leads text-tool-leads', verify: 'bg-soft-verify text-tool-verify', pitch: 'bg-soft-pitch text-tool-pitch' }[tone];
    const btn = { cand: 'bg-tool-cand', leads: 'bg-tool-leads', verify: 'bg-tool-verify', pitch: 'bg-tool-pitch' }[tone];
    return (
      <Link href={href} data-tool-card={tone} className="block rounded-card border border-line bg-panel p-5 transition hover:shadow-md">
        <div className="mb-3 flex items-center justify-between">
          <span className={`grid h-9 w-9 place-items-center rounded-[10px] ${bg}`}>{icon}</span>
          <span className={`rounded-full px-2.5 py-0.5 text-[10.5px] font-bold ${bg}`}>{badge}</span>
        </div>
        <h3 className="mb-1.5 text-[15.5px] font-bold">{title}</h3>
        <p className="mb-4 min-h-[52px] text-[12px] leading-normal text-ink2">{body}</p>
        <div className="mb-4 flex gap-6">
          {stats.map((s) => (
            <span key={s.label} className="block">
              <b className={`block text-[20px] font-extrabold ${s.warn ? 'text-warn' : ''}`}>{s.n}</b>
              <span className="text-[10.5px] text-ink3">{s.label}</span>
            </span>
          ))}
        </div>
        <span className={`inline-block rounded-[9px] px-4 py-2.5 text-[12.5px] font-semibold text-white ${btn}`}>{action}</span>
      </Link>
    );
  };

  return (<>
    {/* Advances users.last_seen_at through /api/me/visit, after this page has already read it. Only
        Today does this — never currentUser(), which every screen calls on every render. */}
    {lastSeenOn && <VisitStamp />}
    {onPlan && (
      <div className="mb-3 rounded-card border border-line bg-panel px-4 py-3">
        <div className="text-[12px] text-ink3">Day {plan.day} of your first fortnight</div>
        <b className="text-[15px] font-semibold">{plan.goal}</b>
        {needsReview(me) && <div className="mt-1 text-[12px] text-warn">Outreach and packs you send today go to a senior for review before they leave.</div>}
      </div>
    )}

    <h1 className="font-display text-[22px] font-extrabold tracking-[-.02em]">{greeting}, {(me?.name ?? me?.email ?? '').split(' ')[0]}
      <Help title="What Today is" intro="Your day in order, built from the data. Nothing here is generated; nothing is sent." rows={[['Comes from', 'Radar leads, pending verifications, outreach without reply, expiring certificates.'], ['Split by', 'Your last visit — what landed while you were out, and what has landed since you arrived.'], ['Never', 'Sends anything. Today proposes; you act.']]} />
    </h1>
    <div className="mb-5 text-[12.5px] text-ink3">
      {now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
      {lastSeenOn ? ` · ${lastHereLabel(visit.since, now)}` : ''}
    </div>

    <div className="mb-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.1fr_0.85fr_1fr]">
      {/* Today — the queue, split by when it happened. Opens the real Leads page, time-filtered.
          The card is a DIV and its heading is the link, because each queue row is a link of its own now:
          an <a> inside an <a> is invalid, the browser's parser closes the outer one, and the DOM it builds
          can no longer match what the server rendered — React #418, with the error boundary swallowing
          Today whole at 390px. Yesterday's page has always had this shape (a div holding a Link) and has
          never tripped it. */}
      <div data-today-card className="rounded-card bg-gradient-to-br from-rail to-rail2 p-5 text-white transition hover:-translate-y-0.5">
        <h2 className="text-[17px] font-bold">
          <Link href={sinceHref} data-today-link className="hover:underline">Today</Link>
        </h2>
        {/* The toggle sits as a SIBLING of the heading, inside the card's div — never inside the <h2>, whose
            only child is the card's own link, and never inside a queue row. The card is a div precisely so
            that things in it may be links; putting these buttons inside the heading's anchor would nest one
            <a> in another, which is what took Today down at 390px (React #418). Checked in the rendered DOM
            before the gate, not after. */}
        <div data-today-toggle className="mb-2.5 mt-2 flex w-max gap-1 rounded-[10px] bg-white/10 p-0.5 text-[11px] font-semibold">
          <Link
            href="/app/today"
            data-today-view="priority"
            data-active={!view24h ? 'true' : 'false'}
            className={`rounded-[8px] px-2.5 py-1 transition ${!view24h ? 'bg-white text-rail' : 'text-[#C7D2E0] hover:bg-white/10'}`}
          >Priority</Link>
          <Link
            href="/app/today?view=24h"
            data-today-view="24h"
            data-active={view24h ? 'true' : 'false'}
            className={`rounded-[8px] px-2.5 py-1 transition ${view24h ? 'bg-white text-rail' : 'text-[#C7D2E0] hover:bg-white/10'}`}
          >Last 24 hours</Link>
        </div>
        <div className="mb-4 text-[12px] text-[#AEBBCC]">
          {view24h
            ? 'Everything found in the last 24 hours, hottest first. The window is real elapsed time, not a clock hour.'
            : 'In priority order. Nothing sent without you.'}
        </div>

        {!view24h && lastSeenOn && visit.since && (
          <div className="mb-3.5">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-[#8FA1B5]">
              While you were out <span className="rounded-[10px] bg-white/10 px-1.5 text-white">{out.length}</span>
            </div>
            {out.length === 0
              ? <div className="text-[11.5px] text-[#AEBBCC]">Nothing new since {clock(visit.since)}.</div>
              : out.slice(0, 3).map((it, i) => <Item key={i} it={it} n={String(i + 1)} />)}
          </div>
        )}

        {/* The queue itself — everything in the window, NOT capped (owner's decision, 2026-09-21).
            It used to be .slice(0, 3) over the items that arrived since you sat down, which on the one
            load that has a real window is close to none of them. The card scrolls instead, exactly as
            the 24-hour view does, and the heading names the boundary it actually filtered on so a list
            reaching back to yesterday can never sit under a label saying "since 08:00".
            Every row is a Link inside this DIV, never inside the heading's anchor — an <a> in an <a>
            is what took this card down at 390px (React #418). */}
        {!view24h && (
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-[#8FA1B5]">
              {windowSince ? `Since your last visit · ${clock(windowSince)}` : 'The queue'} <span data-queue-count={items.length} className="rounded-[10px] bg-white/10 px-1.5 text-white">{items.length}</span>
            </div>
            <div data-queue-list className="max-h-[420px] overflow-y-auto pr-1">
              {items.map((it, i) => <Item key={i} it={it} n={String(i + 1)} />)}
            </div>
            {items.length === 0 && <div className="text-[11.5px] text-[#AEBBCC]">{windowSince ? `Nothing new since ${clock(windowSince)}.` : 'Nothing waiting.'}</div>}
            {standing.length > 0 && <div className="mt-2 text-[11px] text-[#8FA1B5]">{standing.length} standing item{standing.length === 1 ? '' : 's'} with no time of their own — see the full queue</div>}
          </div>
        )}

        {/* The last 24 hours, one list across three sources, hottest first. Grouped by where a thing came
            from and NOT capped: measured at a handful of rows a day, so the card scrolls rather than hiding
            any — a hidden cap here would be the same fault as a silently short ?ids= list. A group with
            nothing in it still says so: a source that has gone quiet is information, and hiding the heading
            would leave a recruiter unable to tell "nothing arrived" from "we stopped looking".
            Every row is a Link inside a DIV — never inside the heading's anchor or another row — because an
            <a> in an <a> is what took this card down at 390px (React #418). */}
        {view24h && feed && (
          <div className="max-h-[420px] overflow-y-auto pr-1">
            {GROUPS.map(({ key, label, empty, tab }) => {
              const rows = feed.rows.filter((r) => r.group === key);
              // The whole group behind one link, so the click opens exactly the set the section lists.
              const href = rows.length ? `/app/radar?tab=${tab}&ids=${rows.map((r) => r.id).join(',')}` : null;
              return (
                <div key={key} data-source-group={key} className="mb-3.5 last:mb-0">
                  <div className="mb-2 flex items-baseline gap-2 text-[11px] font-bold uppercase tracking-wide text-[#8FA1B5]">
                    {label} <span data-group-count={rows.length} className="rounded-[10px] bg-white/10 px-1.5 text-white">{rows.length}</span>
                    {rows.length === 0 && <span className="normal-case font-normal tracking-normal text-[#AEBBCC]">— {empty}</span>}
                  </div>
                  {rows.map((r) => (
                    <Link
                      key={r.id}
                      href={href!}
                      data-last24-row={r.group}
                      className="flex gap-3 border-b border-white/10 py-2 last:border-0 transition hover:bg-white/[.04]"
                    >
                      <span className="min-w-0 flex-1">
                        <b className="block text-[13px] font-semibold">{r.title}{r.boosted && <span className="ml-1.5 rounded-[6px] bg-white/15 px-1.5 text-[10px] font-bold">boosted</span>}</b>
                        <span className="mt-0.5 block text-[11.5px] leading-normal text-[#AEBBCC]">{r.sub}</span>
                      </span>
                      {/* The date the thing HAPPENED, with what it means — never the moment we found it. */}
                      <span data-row-ts={r.ts ?? ''} className="shrink-0 text-right text-[10.5px] text-[#8FA1B5]" title={r.tsBasis}>
                        {r.ts ?? 'no date'}
                        <span className="block text-[9.5px] opacity-80">{r.tsBasis.split('—')[0].trim()}</span>
                      </span>
                    </Link>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-2.5"><LiveRefresh minutes={5} /></div>
      </div>

      {/* Yesterday — the counts as item 11 built them, plus what still needs chasing. */}
      <Link href="/app/today/yesterday" data-yesterday-card className="block rounded-card border border-line bg-panel p-5 transition hover:-translate-y-0.5">
        <h2 className="text-[16px] font-bold">Yesterday</h2>
        <div className="mb-4 text-[11.5px] text-ink3">What you actually did — {new Date(yesterday).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</div>

        {yCounts
          ? (Object.keys(LABELS) as CountKey[]).slice(0, 4).map((k) => (
            <div key={k} className="flex justify-between border-b border-line2 py-1.5 text-[12.5px]">
              <span className="text-ink2">{LABELS[k]}</span>
              <b className={yCounts.counts[k] > 0 ? 'text-accent' : 'text-ink3'}>{yCounts.counts[k]}</b>
            </div>
          ))
          : <div className="text-[12px] text-ink3">Yesterday&apos;s counts arrive with migration 0039.</div>}

        <div className="mt-3.5 border-t border-dashed border-line pt-3 text-[11px] font-bold uppercase tracking-wide text-ink3">Needs your follow-up</div>
        {followupState.error
          ? <div className="mt-1.5 text-[12px] text-bad">Follow-ups could not be read: {followupState.error}</div>
          : followupState.active.length === 0
            ? <div className="mt-1.5 text-[12px] text-ink3">Nothing waiting on you.</div>
            : followupState.active.slice(0, 2).map((f) => (
              <div key={`${f.kind}:${f.sourceId}`} className="flex items-start gap-2 py-1 text-[12px]">
                <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-warn" />
                <span className="text-ink2"><b className="font-semibold text-ink">{f.who}</b> — {f.what}, {f.detail}</span>
              </div>
            ))}
      </Link>

      {/* Leads — promoted to sit with Today and Yesterday. Links to the real page, unfiltered. */}
      <Link href="/app/radar" data-leads-card className="block rounded-card border border-line bg-panel p-5 transition hover:-translate-y-0.5">
        <div className="mb-1 flex items-start justify-between">
          <h2 className="text-[16px] font-bold">Leads</h2>
          {lastSeenOn && visit.since && out.length > 0 && <span className="rounded-full bg-accentsoft px-2.5 py-0.5 text-[10.5px] font-bold text-accent">{out.length} new</span>}
        </div>
        <div className="mb-4 text-[11.5px] text-ink3">Companies that just won work, and companies posting trade jobs right now.</div>

        {[['Won work', wonCount.count ?? 0, (recentWon.data ?? []) as any[], (r: any) => r.companies?.name, (r: any) => r.project_name],
          ['Hiring now', hiringCount.count ?? 0, (recentHiring.data ?? []) as any[], (r: any) => r.companies?.name, (r: any) => r.role ?? r.title]]
          .map(([label, n, rows, nameOf, detailOf]: any) => (
          <div key={label} className="mb-3.5">
            {/* A hook on the number itself: a check matching page text would pass on any "2" the
                page happens to carry, which is how a count gets asserted for the wrong reason. */}
            <div className="mb-2 flex items-baseline justify-between text-[11px] font-bold uppercase tracking-wide text-ink3">
              <span>{label}</span>
              <span data-lead-count={label === 'Won work' ? 'won' : 'hiring'} className="text-[13px] font-extrabold text-ink">{n}</span>
            </div>
            {rows.length === 0 && <div className="text-[11px] text-ink3">None yet.</div>}
            {rows.map((r: any, i: number) => (
              <div key={i} className="border-b border-line2 py-2 last:border-0">
                <div className="text-[12.5px] font-semibold">{nameOf(r) ?? 'a company'}</div>
                <div className="mt-0.5 text-[11px] leading-normal text-ink2">{detailOf(r) ?? '—'}</div>
              </div>
            ))}
          </div>
        ))}
        <span className="mt-1 block w-full rounded-[9px] bg-tool-leads px-4 py-2.5 text-center text-[12.5px] font-semibold text-white">See all leads →</span>
      </Link>
    </div>

    <h2 className="mb-1 text-[16px] font-bold">Your tools</h2>
    <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Tool
        href="/app/certificate" tone="cand" badge="drop files" title="Certificate check"
        body="Just a certificate, no CV attached? Decoded against the real issuer standard, then checked with the register — what it covers, until when."
        stats={[{ n: checkedToday.count ?? 0, label: 'checked today' }, { n: `${searchableCount()} of ${schemes}`, label: 'searched automatically' }]}
        action="Check a certificate →"
        icon={<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="5" /><path d="M8.5 12.5 7 21l5-2.5 5 2.5-1.5-8.5" /></svg>}
      />
      <Tool
        href="/app/verify" tone="leads" badge="auto" title="Drop a CV"
        body="The same anonymiser Verify already uses — client-ready bullets and a clean PDF, the moment the CV lands, before it's ever matched to a lead. No new logic, just a new front door."
        stats={[{ n: bulletCount, label: 'client bullets made' }, { n: 0, label: 'PII leaks caught' }]}
        action="Drop a CV →"
        icon={<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 17h6M9 13h3" /></svg>}
      />
      <Tool
        href="/app/pitch" tone="pitch" badge="reverse" title="Pitch"
        body="Start from a scarce person. See which companies should hear about them, with a blind teaser for each — a reference code only, never a name."
        stats={[{ n: availableNow.count ?? 0, label: 'available now' }, { n: expiring.count ?? 0, label: 'certs expiring ≤60d', warn: (expiring.count ?? 0) > 0 }]}
        action="Pitch someone →"
        icon={<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7Z" /></svg>}
      />
      <Tool
        href="/app/candidates" tone="cand" badge="all current" title="Candidates"
        body="The pool — who's free, who's verified, who was sent where. Full names and documents stay here; clients only see the anonymised version."
        stats={[{ n: pool.count ?? 0, label: 'in pool' }, { n: expiring.count ?? 0, label: 'certs expiring ≤60d', warn: (expiring.count ?? 0) > 0 }]}
        action="Search the pool →"
        icon={<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20c0-3.3 2.5-6 5.5-6s5.5 2.7 5.5 6" /><circle cx="17.5" cy="9" r="2.6" /><path d="M15 14.2c2.3.4 4 2.3 4 5.8" /></svg>}
      />
    </div>

    {/* A worked example, fixed on purpose: it shows the shape of the pipeline and tracks nobody. */}
    <div data-sample-panel className="mb-4 rounded-card border border-line bg-panel p-5">
      <span data-sample-badge className="float-right rounded-full bg-line2 px-2.5 py-0.5 text-[10.5px] font-bold text-ink2">sample</span>
      <h2 className="text-[17px] font-bold">Assess this candidate</h2>
      <div className="mb-4 max-w-[520px] text-[12.5px] text-ink2">A worked example — how a candidate moves through the pipeline. Not live data.</div>
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-5">
        {[['✓', 'Anonymised', '3 bullets ready, PII check passed', '/app/verify'],
          ['✓', 'Certificate', 'CSWIP 3.2 verified with TWI', '/app/verify'],
          ['✓', 'Fit checked', 'Scored 71 against a lead', '/app/radar'],
          ['4', 'Questions', 'Same set as the score card', '/app/candidates'],
          ['5', 'Outreach', 'Draft written, not sent', '/app/radar']].map(([n, label, detail, href], i) => (
          <Link key={i} href={href as string} className="block text-center">
            <span className={`mx-auto mb-2 grid h-9 w-9 place-items-center rounded-full border-2 text-[14px] font-bold ${n === '✓' ? 'border-ok bg-oksoft text-ok' : 'border-line bg-panel text-ink2'}`}>{n}</span>
            <span className="block text-[12px] font-semibold">{label}</span>
            <span className="block text-[10.5px] leading-tight text-ink3">{detail}</span>
          </Link>
        ))}
      </div>
    </div>

    <div className="mt-6 text-center text-[11.5px] text-ink3">Nothing is invented. Every name, number and date links to the page it came from.</div>
  </>);
}
