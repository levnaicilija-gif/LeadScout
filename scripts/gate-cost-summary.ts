/**
 * WHAT THIS GATE COST — printed at the end of every run. Read-only, one query, no model call.
 *
 *   GATE_STARTED_AT=<iso> npx tsx --env-file=.env.local scripts/gate-cost-summary.ts
 *
 * The cost of a gate was invisible until it was measured by hand on 2026-10-07, and the figure everyone had
 * been quoting — "about €0.20" — was from 2026-09-15, before the probe set grew: a full gate is 44 calls and
 * about $0.58. Printing it per run means nobody has to reconstruct it from cost_log again, and a gate that
 * suddenly costs double says so on the spot.
 *
 * TWO NUMBERS, because they answer different questions: what THIS run cost, and what today's test spend has
 * reached. The second is the one that matters for the daily test budget.
 *
 * It never fails the gate. A cost report that can turn a green run red would be a reason to delete it.
 */
import { probeAdmin } from '../src/lib/test-data';
import { isTestSpend } from '../src/lib/cost';

const USD_PER_EUR = 1.16;
const started = process.env.GATE_STARTED_AT;

(async () => {
  try {
    const db = probeAdmin();
    // The day boundary comes from the DATABASE, never from new Date() — this machine's clock has read stale.
    const probe = await db.from('cost_log').insert({ kind: 'fetch', detail: 'gate-cost-summary clock probe (no spend)', eur: 0 }).select('id, created_at, day').single();
    if (probe.error) { console.log('cost summary unavailable: the clock could not be read (' + probe.error.message.slice(0, 80) + ')'); return; }
    await db.from('cost_log').delete().eq('id', probe.data.id);
    const today = String(probe.data.day);

    const { data, error } = await db.from('cost_log')
      .select('kind, detail, eur, workspace_id, created_at').eq('day', today).limit(2000);
    if (error) { console.log('cost summary unavailable: ' + error.message.slice(0, 90)); return; }
    const rows = data ?? [];

    const wsIds = [...new Set(rows.map((r) => r.workspace_id).filter((x): x is string => !!x))];
    const tests = new Set<string>();
    for (let i = 0; i < wsIds.length; i += 200) {
      const { data: w } = await db.from('workspaces').select('id, is_test').in('id', wsIds.slice(i, i + 200));
      for (const x of w ?? []) if (x.is_test) tests.add(x.id);
    }

    const testRows = rows.filter((r) => isTestSpend(r, tests));
    const testEur = testRows.reduce((a, r) => a + (Number(r.eur) || 0), 0);

    // THIS run: rows since the gate started. Without GATE_STARTED_AT the run cannot be isolated, and that is
    // said rather than guessed at from a window that might include the last run too.
    if (started && !Number.isNaN(Date.parse(started))) {
      const mine = testRows.filter((r) => Date.parse(r.created_at) >= Date.parse(started));
      const mineEur = mine.reduce((a, r) => a + (Number(r.eur) || 0), 0);
      const byKind = new Map<string, number>();
      for (const r of mine) byKind.set(String(r.kind), (byKind.get(String(r.kind)) ?? 0) + 1);
      const top = [...byKind].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k}×${n}`).join(' ');
      console.log(`THIS GATE: ${mine.length} model call(s), $${(mineEur * USD_PER_EUR).toFixed(2)} (€${mineEur.toFixed(2)})`);
      if (top) console.log(`   ${top}`);
      if (mine.length === 0) console.log('   no model call was made — either the browser block was skipped, or every cached call replayed');
      else if (mine.length < 10) console.log('   NOTE: a full gate is about 44 calls; a much smaller number means the browser block did not run');
    } else {
      console.log('THIS GATE: not isolated — GATE_STARTED_AT was not set, so only today\'s total is shown');
    }

    console.log(`TODAY (${today}) test spend so far: $${(testEur * USD_PER_EUR).toFixed(2)} (€${testEur.toFixed(2)}) over ${testRows.length} call(s)`);
    const allEur = rows.reduce((a, r) => a + (Number(r.eur) || 0), 0);
    console.log(`   today's spend of every kind, test included: $${(allEur * USD_PER_EUR).toFixed(2)} (€${allEur.toFixed(2)})`);
  } catch (e: any) {
    // Never fail the gate for a report.
    console.log('cost summary unavailable: ' + String(e?.message ?? e).slice(0, 110));
  }
})();
