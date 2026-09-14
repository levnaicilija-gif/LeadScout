import type { SupabaseClient } from '@supabase/supabase-js';
import { hasTable } from '@/lib/schema-features';
import { watchedBoards } from '@/lib/watchlist';
import { runRadarBatch } from './radar-batch';
import { runJobPostsBatch } from './job-posts-batch';
import { runCareersDiscoveryBatch } from './careers-discovery-batch';

/**
 * The schedule for the three crawls. Supabase pg_cron calls /api/jobs/tick every five minutes (0029), and
 * Vercel cron at 04:05 as a backstop. A tick runs batches one after another inside its own invocation until
 * it has used its time, then stops. Nothing is handed on, so there is no chain to break.
 *
 * Why: on 14 September 2026 the HTTP hand-off chain started every Radar batch within two seconds of the first
 * and Vercel refused the fifth with 508 INFINITE_LOOP_DETECTED (a function calling its own deployment is capped
 * however it is timed); the job crawl's and discovery's batches, started together, picked the same companies.
 * Here a batch starts only after the one before it has written its rows.
 *
 * What is due is read again before every batch, in this order:
 *   radar       from 04:00 UTC until today's run has read its last source or stopped at the cap
 *   discovery   while a company with a domain has never been checked
 *   job-posts   while a company with a board has not been crawled since 00:00 UTC
 *
 * One tick at a time: job_ticks allows a single unfinished row (0029), and a tick that cannot insert one
 * exits. Before 0029 is applied the tick still runs, unrecorded and unguarded.
 */

export type TickUnit = 'radar' | 'discovery' | 'job-posts';
export type TickSource = 'pg_cron' | 'vercel_cron' | 'manual';
export type TickOptions = { source: TickSource; origin: string; dryRun?: boolean; unit?: TickUnit; force?: boolean; maxBatches?: number };

// A batch starts only while the tick is younger than this, so a slow batch still ends inside the route's
// 300 s. Measured 2026-09-14 on production, one batch at a time: Radar batches of 5 sources took 163 s
// (40 new articles), 30 s (none) and 268 s (32) — one source is the Radar batch here for that reason.
const START_BATCH_BEFORE_MS = 120_000;
const BATCH: Record<TickUnit, number> = { radar: 1, discovery: 25, 'job-posts': 4 };
const RADAR_HOUR_UTC = 4;
// An unfinished tick older than the route's 300 s maxDuration (plus margin) was killed.
const KILLED_AFTER_MS = 330_000;

type Due = { unit: TickUnit; path: string; why: string };
type Note = { unit: TickUnit; secs: number; why?: string; error?: string; capped?: boolean; [k: string]: unknown };

const day = (now: Date) => now.toISOString().slice(0, 10);

async function radarDue(db: SupabaseClient, now: Date): Promise<Due | string> {
  if (now.getUTCHours() < RADAR_HOUR_UTC) return `waits for ${RADAR_HOUR_UTC}:00 UTC`;
  const { data, error } = await db.from('radar_runs').select('cursor, batch, tally, finished_at')
    .gte('started_at', `${day(now)}T0${RADAR_HOUR_UTC}:00:00Z`).in('tier', ['priority', 'all'])
    .order('cursor', { ascending: false }).limit(1);
  if (error) throw new Error(`radar_runs could not be read: ${error.message}`);
  const last: any = data?.[0];
  const at = (cursor: number, why: string): Due => ({ unit: 'radar', path: `/api/jobs/radar?cursor=${cursor}&batch=${BATCH.radar}`, why });
  if (!last) return at(0, "today's run has not started");
  const next = Number(last.cursor) + Number(last.batch);
  // A batch that never finished died with its invocation. Moving past it keeps one source that hangs from
  // stopping the run every five minutes; the sources it did read are stamped.
  if (!last.finished_at) return at(next, `the batch at source ${last.cursor} never finished; continuing after it`);
  if (last.tally?.budgetStopped) return "today's run stopped at the daily cap";
  // `more` is written from 2026-09-14; before that, a batch that read fewer sources than its size was the last.
  const more = typeof last.tally?.more === 'boolean' ? last.tally.more : Number(last.tally?.sources ?? 0) >= Number(last.batch);
  return more ? at(next, `continuing at source ${next}`) : `today's run has read its last source`;
}

async function discoveryDue(db: SupabaseClient, force: boolean): Promise<Due | string> {
  const due = (why: string): Due => ({ unit: 'discovery', path: `/api/jobs/careers-discovery?batch=${BATCH.discovery}`, why });
  if (force) return due('forced');
  const { count, error } = await db.from('companies').select('id', { count: 'exact', head: true })
    .not('domain', 'is', null).neq('employer_type', 'staffing_agency').is('careers_checked_at', null);
  if (error) throw new Error(`companies could not be counted: ${error.message}`);
  return count ? due(`${count} companies never checked`) : 'every company with a domain has been checked';
}

async function jobPostsDue(db: SupabaseClient, now: Date, force: boolean): Promise<Due | string> {
  const due = (why: string): Due => ({ unit: 'job-posts', path: `/api/jobs/job-posts?batch=${BATCH['job-posts']}`, why });
  if (force) return due('forced');
  const { count, error } = await db.from('companies').select('id', { count: 'exact', head: true })
    .eq('careers_status', 'found').neq('employer_type', 'staffing_agency')
    .or(`last_jobs_crawl_at.is.null,last_jobs_crawl_at.lt."${day(now)}T00:00:00Z"`);
  if (error) throw new Error(`companies could not be counted: ${error.message}`);
  if (count) return due(`${count} boards not crawled today`);
  // Item 18 part 4: once every board has had today's read, a watched board is read again when it is 12 hours old.
  const watched = await watchedBoards(db, now);
  if (watched?.dueIds.length) {
    return { unit: 'job-posts', path: `/api/jobs/job-posts?batch=${BATCH['job-posts']}&watch=1`, why: `${watched.dueIds.length} watched boards due their second read` };
  }
  return `every board has been crawled today${watched ? ` (${watched.ids.length} watched, none due again)` : ''}`;
}

/** One batch, called in this process — no HTTP, so nothing for Vercel's recursion guard to count. */
async function runBatch(due: Due, origin: string): Promise<Note> {
  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 1000);
  const req = new Request(`${origin}${due.path}`, { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET ?? '' } });
  try {
    const res = due.unit === 'radar' ? await runRadarBatch(req) : due.unit === 'discovery' ? await runCareersDiscoveryBatch(req) : await runJobPostsBatch(req);
    const text = await res.text();
    let j: any;
    try { j = JSON.parse(text); } catch { return { unit: due.unit, secs: secs(), error: `HTTP ${res.status}, not JSON: ${text.slice(0, 160)}` }; }
    if (res.status !== 200) return { unit: due.unit, secs: secs(), error: `HTTP ${res.status}: ${String(j?.error ?? text).slice(0, 160)}` };
    if (due.unit === 'radar') {
      const t = j.tally ?? {};
      return {
        unit: 'radar', secs: secs(), cursor: j.cursor, sources: t.sources, unreachable: t.sourcesUnreachable, articlesRead: t.articlesRead,
        leads: t.leads, rejected: t.rejected, modelEur: t.modelEur, capped: !!t.budgetStopped, more: j.nextCursor != null,
        ...(j.tenders ? { tenders: j.tenders.error ? `error: ${j.tenders.error}` : `${j.tenders.leadsCreated} leads from ${j.tenders.noticesChecked} notices` } : {}),
      };
    }
    if (due.unit === 'discovery') return { unit: 'discovery', secs: secs(), ...(j.stats ?? {}), remaining: j.remaining };
    return { unit: 'job-posts', secs: secs(), ...(j.stats ?? {}), stopped: j.stopped, spentToday: j.spentToday, capped: !!j.stopped || Number(j.budgetLeft) <= 0 };
  } catch (e: any) {
    return { unit: due.unit, secs: secs(), error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** The row id, 'busy' when another tick holds the one unfinished row, or null when job_ticks is not there yet. */
async function openTick(db: SupabaseClient, source: TickSource): Promise<string | null | 'busy'> {
  if (!(await hasTable(db, 'job_ticks'))) return null;
  await db.from('job_ticks').update({ finished_at: new Date().toISOString(), error: 'never finished: its invocation was killed or timed out' })
    .is('finished_at', null).lt('started_at', new Date(Date.now() - KILLED_AFTER_MS).toISOString());
  const { data, error } = await db.from('job_ticks').insert({ source }).select('id').single();
  if (error?.code === '23505') return 'busy';
  if (error) throw new Error(`job_ticks could not be written: ${error.message}`);
  return data.id;
}

async function closeTick(db: SupabaseClient, id: string | null, r: { batches: Note[]; stopped: string; error: string | null }) {
  if (!id) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await db.from('job_ticks')
      .update({ finished_at: new Date().toISOString(), batches: r.batches, batch_count: r.batches.length, stopped: r.stopped, error: r.error })
      .eq('id', id);
    if (!error) break;
    // Left unfinished, the row blocks ticks until the next one after KILLED_AFTER_MS marks it killed.
    if (attempt < 3) await new Promise((ok) => setTimeout(ok, 2000 * attempt));
  }
  // Ticks that found nothing to do are kept two days: enough to see the schedule is calling.
  await db.from('job_ticks').delete().eq('batch_count', 0).lt('started_at', new Date(Date.now() - 2 * 86400000).toISOString());
}

export async function runTick(db: SupabaseClient, o: TickOptions) {
  const started = Date.now();
  const skip = new Set<TickUnit>();
  const whatIsDue = async () => {
    const now = new Date();
    const notDue: Partial<Record<TickUnit, string>> = {};
    const checks: [TickUnit, () => Promise<Due | string>][] = [
      ['radar', () => radarDue(db, now)],
      ['discovery', () => discoveryDue(db, !!o.force)],
      ['job-posts', () => jobPostsDue(db, now, !!o.force)],
    ];
    for (const [unit, check] of checks) {
      if ((o.unit && o.unit !== unit) || skip.has(unit)) continue;
      const r = await check();
      if (typeof r !== 'string') return { due: r, notDue };
      notDue[unit] = r;
    }
    return { due: null, notDue };
  };

  if (o.dryRun) return { dryRun: true, ...(await whatIsDue()) };

  const lease = await openTick(db, o.source);
  if (lease === 'busy') return { busy: true, why: 'another tick is still running' };
  const batches: Note[] = [];
  let stopped = '';
  let error: string | null = null;
  try {
    for (;;) {
      if (Date.now() - started >= START_BATCH_BEFORE_MS) { stopped = 'time used; the next tick continues'; break; }
      if (o.maxBatches && batches.length >= o.maxBatches) { stopped = `stopped after ${o.maxBatches} batch(es) as asked`; break; }
      const { due, notDue } = await whatIsDue();
      if (!due) { stopped = `nothing due: ${Object.entries(notDue).map(([u, w]) => `${u} ${w}`).join('; ')}`; break; }
      const note: Note = { ...(await runBatch(due, o.origin)), why: due.why };
      batches.push(note);
      console.log(`[tick] ${JSON.stringify(note)}`);
      if (note.error) { stopped = `the ${due.unit} batch failed`; break; }
      const progressed = due.unit === 'radar' ? Number(note.sources ?? 0) > 0
        : due.unit === 'discovery' ? Number(note.looked ?? 0) > 0
        : Number(note.companies ?? 0) > 0;
      // A unit at the cap, one that did nothing, or a forced one is not taken again in this tick.
      if (note.capped || !progressed || o.force) skip.add(due.unit);
    }
  } catch (e: any) {
    error = String(e?.message ?? e).slice(0, 300);
    stopped = stopped || 'the tick failed';
  }
  await closeTick(db, lease, { batches, stopped, error });
  return { source: o.source, recorded: !!lease, secs: Math.round((Date.now() - started) / 1000), batches, stopped, error };
}
