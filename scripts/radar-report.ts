/**
 * What a Radar run actually did. Reads radar_runs where there is one, and falls back to
 * re-reading the day's stored articles for runs from before that table existed.
 *
 *   npx tsx --env-file=.env.local scripts/radar-report.ts 2026-09-10
 */
import { createClient } from '@supabase/supabase-js';
import { extractLead } from '../src/lib/ai/radar-extract';

const day = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

(async () => {
  const { data: runs } = await db.from('radar_runs').select('*').gte('started_at', `${day}T00:00:00Z`).lt('started_at', `${day}T23:59:59Z`).order('started_at');
  if (runs?.length) {
    console.log(`${runs.length} Radar invocations on ${day}\n`);
    const all = { sources: 0, articlesRead: 0, leads: 0, rejected: 0, fetchFailed: 0, alreadySeen: 0, sourcesUnreachable: 0 };
    const why = new Map<string, number>();
    for (const r of runs) {
      for (const k of Object.keys(all)) (all as any)[k] += (r.tally as any)?.[k] ?? 0;
      for (const x of (r.rejected as any[]) ?? []) why.set(x.why, (why.get(x.why) ?? 0) + 1);
      if (!r.finished_at) console.log(`  cursor ${r.cursor} started ${r.started_at} and never finished — killed by the 300 s limit`);
    }
    console.log(all);
    console.log('\nrejections by reason:');
    [...why.entries()].sort((a, b) => b[1] - a[1]).forEach(([w, n]) => console.log(`  ${String(n).padStart(3)}  ${w}`));
    return;
  }

  console.log(`no radar_runs row for ${day} — re-reading the day's stored articles instead\n`);
  const { data: arts } = await db.from('articles').select('id, url, title, text, source_id, fetched_at')
    .gte('fetched_at', `${day}T00:00:00Z`).lt('fetched_at', `${day}T23:59:59Z`);
  const { data: sources } = await db.from('sources').select('id, url');
  const byId = new Map((sources ?? []).map((s) => [s.id, s.url]));

  const perSource = new Map<string, number>();
  for (const a of arts ?? []) perSource.set(byId.get(a.source_id) ?? '?', (perSource.get(byId.get(a.source_id) ?? '?') ?? 0) + 1);
  console.log('articles fetched, by source:');
  perSource.forEach((n, s) => console.log(`  ${String(n).padStart(3)}  ${s}`));

  console.log(`\nre-reading ${(arts ?? []).length} articles under the Stage 1 rules:\n`);
  const why = new Map<string, number>();
  for (const a of arts ?? []) {
    const res = await extractLead(a.text ?? '', a.url);
    if (res.ok) {
      console.log(`  LEAD  ${res.lead.company} — ${a.title?.slice(0, 80)}`);
    } else {
      const short = res.why.replace(/\s+/g, ' ').slice(0, 110);
      why.set(short, (why.get(short) ?? 0) + 1);
      console.log(`  no    ${(a.title ?? a.url).slice(0, 70)}\n        ${short}`);
    }
  }
  console.log('\nrejections by reason:');
  [...why.entries()].sort((a, b) => b[1] - a[1]).forEach(([w, n]) => console.log(`  ${String(n).padStart(3)}  ${w}`));
})();
