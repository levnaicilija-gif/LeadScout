/**
 * Every source type is read by exactly one pipeline, and a job board is read by its own.
 *
 *   npx tsx scripts/source-routing-check.ts
 *
 * Source-reading, like model-meter-check: no database, no network, no model call, so it belongs in the
 * release gate. What it pins down is a fault that nothing could see for weeks, because every symptom
 * pointed somewhere else (2026-09-21):
 *
 *   /api/jobs/job-boards was scheduled by nothing — the Vercel crons are the tick and the recheck, and
 *   the tick had three units, none of them this one. So is_trade_vacancy and via='board' had never
 *   executed in production: 0 "board advert" rows in cost_log, €0.00.
 *
 *   Meanwhile radar-batch selected every enabled source with NO type filter, so the nine enabled
 *   job_board rows were crawled as news and stored as articles — 92 of them, backing not one lead. The
 *   boards looked healthy the whole time: "enabled", with a recent last_crawled_at, stamped by radar.
 *
 *   repair-sources had the same missing filter, and its test — "does a newsroom carry article links" —
 *   switches a source OFF when it fails. That is meaningless for a board and is what disabled two of
 *   them. Fixing radar alone would have handed the boards straight back to it.
 *
 * A missing `.neq(...)` is one forgotten clause, it reads as harmless, and nothing downstream complains:
 * the wrong pipeline simply does its job on the wrong input and writes rows that look plausible. So the
 * clause is asserted here rather than trusted, and each assertion was proved by mutating the file it
 * reads and watching this check fail.
 */
import { readFileSync } from 'fs';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const read = (p: string) => readFileSync(p, 'utf8');
/** The file with comments stripped, so a rule quoted in a comment cannot satisfy a check. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

console.log('--- job boards are not read as news ---');
const radar = code('src/lib/jobs/radar-batch.ts');
const radarQuery = radar.match(/db\.from\('sources'\)[^;]*/)?.[0] ?? '';
check(/\.neq\('type',\s*'job_board'\)/.test(radarQuery),
  "radar-batch's source query excludes job_board", radarQuery.replace(/\s+/g, ' ').slice(0, 120) || 'no sources query found');

const repair = code('src/app/api/jobs/repair-sources/route.ts');
const repairQuery = repair.match(/db\.from\('sources'\)[^;]*/)?.[0] ?? '';
check(/\.neq\('type',\s*'job_board'\)/.test(repairQuery),
  "repair-sources' source query excludes job_board — it switches off what fails its newsroom test", repairQuery.replace(/\s+/g, ' ').slice(0, 120) || 'no sources query found');

console.log('\n--- and they ARE read by their own pipeline ---');
const boards = code('src/lib/jobs/job-boards-batch.ts');
check(/\.eq\('type',\s*'job_board'\)/.test(boards), "job-boards-batch reads only job_board sources");
check(/\.eq\('enabled',\s*true\)/.test(boards), 'and only enabled ones');

const tick = code('src/lib/jobs/tick.ts');
check(/'job-boards'/.test(tick.match(/export type TickUnit[^;]*/)?.[0] ?? ''), "the tick knows a 'job-boards' unit");
check(/\['job-boards',\s*\(\)\s*=>\s*jobBoardsDue/.test(tick), 'and checks whether it is due, beside the other three');
check(/runJobBoardsBatch\(req\)/.test(tick), 'and dispatches to its batch');
check(/'job-boards':\s*\d+/.test(tick.match(/const BATCH[^;]*/)?.[0] ?? ''), 'with a batch size of its own');

// UNITS.find returns undefined for a name not in the list, and the tick reads that as "no unit given"
// and runs EVERYTHING — so a unit missing here does not 400, it silently means the whole schedule.
const tickRoute = code('src/app/api/jobs/tick/route.ts');
const units = tickRoute.match(/const UNITS[^;]*/)?.[0] ?? '';
check(/'job-boards'/.test(units), "the tick route's UNITS allow-list carries it, or ?unit=job-boards silently runs everything", units.replace(/\s+/g, ' '));

console.log('\n--- nothing hands a batch on to its own deployment ---');
// A function calling its own deployment is refused with 508 INFINITE_LOOP_DETECTED after a few hops.
for (const [name, path] of [
  ['job-boards', 'src/lib/jobs/job-boards-batch.ts'],
  ['radar', 'src/lib/jobs/radar-batch.ts'],
] as const) {
  const body = code(path);
  check(!/batchesLeft/.test(body) || !/fetch\(u\.toString\(\)/.test(body),
    `${name} starts no follow-on batch of its own`, /fetch\(u\.toString\(\)/.test(body) ? 'it dispatches to its own URL' : '');
}

console.log(failures ? `\nsource routing: ${failures} FAILED` : '\nsource routing: all checks passed');
process.exit(failures ? 1 : 0);
