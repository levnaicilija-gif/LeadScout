/**
 * Is the crawl schedule running? Read-only.
 *
 *   npx tsx --env-file=.env.local scripts/schedule-report.ts [hours=24] [--expect-cron]
 *
 * Ticks from job_ticks (0029) by source, every batch they ran, and where today's work stands: Radar's run,
 * boards crawled today, companies never checked. --expect-cron exits 1 when no pg_cron tick has finished in
 * the last 15 minutes, or when a tick failed or was killed in the window.
 */
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const hours = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 24);
const expectCron = process.argv.includes('--expect-cron');

(async () => {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  const { data: ticks, error } = await db.from('job_ticks').select('*').gte('started_at', since).order('started_at', { ascending: true });
  if (error) { console.error(`job_ticks could not be read: ${error.message} (is 0029 applied?)`); process.exit(1); }

  const bySource: Record<string, number> = {};
  const byUnit: Record<string, { batches: number; secs: number; errors: number }> = {};
  const problems: string[] = [];
  for (const t of ticks ?? []) {
    bySource[t.source] = (bySource[t.source] ?? 0) + 1;
    for (const b of (t.batches ?? []) as any[]) {
      const u = (byUnit[b.unit] ??= { batches: 0, secs: 0, errors: 0 });
      u.batches++; u.secs += Number(b.secs ?? 0); if (b.error) u.errors++;
    }
    if (t.error) problems.push(`${t.started_at} ${t.source}: ${t.error}`);
    if (t.batch_count) {
      const secs = t.finished_at ? Math.round((new Date(t.finished_at).getTime() - new Date(t.started_at).getTime()) / 1000) : null;
      console.log(`${t.started_at.slice(0, 19)} ${t.source.padEnd(11)} ${String(secs ?? 'running').padStart(4)}s ${t.batch_count} batch(es) — ${t.stopped ?? ''}`);
      for (const b of t.batches as any[]) console.log(`    ${JSON.stringify(b)}`);
    }
  }
  const idle = (ticks ?? []).filter((t) => !t.batch_count).length;
  console.log(`\nticks in the last ${hours} h: ${JSON.stringify(bySource)} · ${idle} found nothing due`);
  console.log(`batches: ${JSON.stringify(byUnit)}`);

  const { data: radar } = await db.from('radar_runs').select('cursor, batch, tally, finished_at').gte('started_at', `${today}T04:00:00Z`).in('tier', ['priority', 'all']).order('cursor', { ascending: false }).limit(1);
  const r: any = radar?.[0];
  const count = async (q: any) => (await q).count;
  const boards = await count(db.from('companies').select('id', { count: 'exact', head: true }).eq('careers_status', 'found').neq('employer_type', 'staffing_agency'));
  const crawled = await count(db.from('companies').select('id', { count: 'exact', head: true }).eq('careers_status', 'found').neq('employer_type', 'staffing_agency').gte('last_jobs_crawl_at', `${today}T00:00:00Z`));
  const unchecked = await count(db.from('companies').select('id', { count: 'exact', head: true }).not('domain', 'is', null).neq('employer_type', 'staffing_agency').is('careers_checked_at', null));
  console.log(`today: Radar ${r ? `last batch at source ${r.cursor}${r.tally?.more === false || (r.tally?.more == null && Number(r.tally?.sources ?? 0) < r.batch) ? ' (run read its last source)' : ''}${r.tally?.budgetStopped ? ' (stopped at the cap)' : ''}` : 'not started'} · boards crawled ${crawled}/${boards} · companies never checked ${unchecked}`);

  if (problems.length) console.log(`\nproblems:\n  ${problems.join('\n  ')}`);
  if (expectCron) {
    const lastCron = (ticks ?? []).filter((t) => t.source === 'pg_cron' && t.finished_at).at(-1);
    const fresh = lastCron && Date.now() - new Date(lastCron.finished_at).getTime() < 15 * 60000;
    if (!fresh) console.log(`\nFAIL: no pg_cron tick finished in the last 15 minutes (last: ${lastCron?.finished_at ?? 'never'})`);
    if (!fresh || problems.length) process.exit(1);
    console.log('\nschedule: pg_cron is calling the tick and no tick failed');
  }
})().catch((e) => { console.error(e); process.exit(1); });
