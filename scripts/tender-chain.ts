/**
 * The tender chain by hand (src/lib/jobs/tender-chain.ts — the same code the tick runs).
 *
 *   npx tsx --env-file=.env.local scripts/tender-chain.ts                       DRY RUN: the queue, its order, how many
 *                                                                              today, the estimated cost. Spends nothing.
 *   npx tsx --env-file=.env.local scripts/tender-chain.ts --ids <id> --write    ONE named company, live — the proof run.
 *                                                                              Runs whatever the kill switch says, because
 *                                                                              naming a company is the owner's explicit act.
 *
 * Before 0062 is applied the DRY RUN takes the day from the database server's HTTP Date header and says so; a live
 * run refuses, because the slice and the cap must be read on the database's own day.
 */
import { probeAdmin } from '../src/lib/test-data';
import { spentEur, DAILY_BUDGET_EUR } from '../src/lib/cost';
import { chainSwitch, dbToday, sliceSpent, tenderQueue, runTenderChain, SLICE_EUR, LOOKUP_ESTIMATE_EUR, MAX_LOOKUPS } from '../src/lib/jobs/tender-chain';
import { ageBucket } from '../src/lib/discovery-order';

const db = probeAdmin();
const write = process.argv.includes('--write');
const idsAt = process.argv.indexOf('--ids');
const ids = idsAt > 0 ? String(process.argv[idsAt + 1] ?? '').split(',').filter(Boolean) : [];
// Measured per company: €0.0230 (batch 1, 35 companies), €0.0253 (address-aware, 48), €0.0343 (HOLBØLL, 4 searches).
const MEASURED_EUR = 0.0253;

(async () => {
  if (write && !ids.length) { console.log('A live run from this script must NAME its companies (--ids). The backlog runs from the tick, once the owner turns the switch on.'); process.exitCode = 2; return; }
  let day: string; let clock = 'the database clock (db_utc_today)';
  try { day = await dbToday(db); } catch (e: any) {
    if (write) { console.log(`refused: ${e.message}`); process.exitCode = 2; return; }
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, { method: 'HEAD', headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY! } });
    day = new Date(res.headers.get('date') ?? '').toISOString().slice(0, 10);
    clock = 'the database server\'s HTTP Date header — 0062 is NOT applied yet, so this is the dry run\'s stand-in, never the chain\'s';
  }
  const sw = await chainSwitch(db);
  const slice = await sliceSpent(db, day);
  const cap = await spentEur(db, { day });
  console.log(`day ${day} by ${clock}`);
  console.log(`kill switch: ${sw.enabled ? 'ON' : 'OFF'} — ${sw.why}`);
  console.log(`spend today: tender slice €${slice.toFixed(4)} of €${SLICE_EUR.toFixed(2)} · cap €${cap.toFixed(4)} of €${DAILY_BUDGET_EUR.toFixed(2)} (test traffic excluded)`);

  if (!write) {
    const { queue, skipped, finalMisses } = await tenderQueue(db, day);
    const room = Math.max(0, Math.min(SLICE_EUR - slice, DAILY_BUDGET_EUR - cap));
    // A lookup starts only while €0.05 is left, so the count is set by the estimate and the cost by the measurement.
    const today = Math.min(queue.length, Math.max(0, Math.floor((room - LOOKUP_ESTIMATE_EUR) / MEASURED_EUR) + 1));
    console.log(`\nqueue: ${queue.length} tender winners to look up (freshest award first) · ${queue.filter((t) => ageBucket(t) === 0).length} fresh, ${queue.filter((t) => ageBucket(t) === 1).length} older, ${queue.filter((t) => ageBucket(t) === 2).length} undated · ${queue.filter((t) => t.lookups === 1).length} retries`);
    console.log(`not in the queue: ${finalMisses} already final "no website" (${MAX_LOOKUPS} lookups), ${skipped.length} skipped with a reason`);
    for (const t of skipped) console.log(`  SKIP ${t.name} — ${t.skipped}`);
    console.log(`\norder (first ${Math.min(queue.length, 60)}):`);
    queue.slice(0, 60).forEach((t, i) => console.log(`  ${String(i + 1).padStart(3)}. ${t.name} · ${t.leadCountry ?? '—'} · ${t.age === Number.MAX_SAFE_INTEGER ? 'undated' : `${t.age} d`} · lookup ${t.lookups + 1} of ${MAX_LOOKUPS} · notice ${t.notice ?? '—'} · id ${t.id}`));
    console.log(`\ntoday: room €${room.toFixed(2)} → about ${today} lookup(s), about €${(today * MEASURED_EUR).toFixed(2)} at the measured €${MEASURED_EUR} a company (up to €${(today * 0.0343).toFixed(2)} at HOLBØLL's €0.0343)`);
    console.log(`whole queue: about €${(queue.length * MEASURED_EUR).toFixed(2)} (€${(queue.length * 0.0343).toFixed(2)} at the high end) → about ${Math.ceil((queue.length * MEASURED_EUR) / SLICE_EUR)} day(s) of the €${SLICE_EUR.toFixed(2)} slice`);
    console.log('\nDRY RUN — nothing looked up, nothing spent, nothing written.');
    return;
  }

  const run = await runTenderChain(db, { batch: ids.length, write: true, ids });
  console.log(`\n${run.stopped}`);
  if (!run.outcomes.length) console.log(`nothing ran: none of ${ids.join(', ')} is in today's queue (already has a domain, final, looked up today, or not a prospect)`);
  for (const o of run.outcomes) console.log(JSON.stringify(o, null, 2));
  console.log(`\nspent €${run.eur.toFixed(4)} · tender slice now €${run.sliceSpent.toFixed(4)} of €${SLICE_EUR.toFixed(2)} · cap €${run.capSpent.toFixed(4)} of €${DAILY_BUDGET_EUR.toFixed(2)}`);
})().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; });
