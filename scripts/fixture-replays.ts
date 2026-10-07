/**
 * HOW MANY MODEL CALLS THIS GATE REPLAYED INSTEAD OF MAKING — printed as its own step.
 *
 *   npx tsx scripts/fixture-replays.ts
 *
 * The point is that a replayed gate must not look like a live one. The cache appends a line per replay to
 * .cache/model-fixtures/replayed.log, which release-gate.sh truncates when it starts the server, so the count
 * belongs to THIS run. Exits 0 either way: replaying is the intended behaviour, and zero replays is equally
 * fine on a first run or after a prompt change.
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const LOG = path.join('.cache', 'model-fixtures', 'replayed.log');
if (!existsSync(LOG)) {
  console.log('REPLAYED: 0 — no fixture was replayed in this run (first run, or every key missed)');
  console.log('   every cached model call in this gate was LIVE');
} else {
  const lines = readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes('REPLAYED'));
  const byTool = new Map<string, number>();
  for (const l of lines) {
    const m = l.match(/REPLAYED (\S+)/);
    if (m) byTool.set(m[1], (byTool.get(m[1]) ?? 0) + 1);
  }
  console.log(`REPLAYED: ${lines.length} model call(s) served from the fixture cache in this run`);
  for (const [t, n] of [...byTool].sort((a, b) => b[1] - a[1])) console.log(`   ${t}: ${n}`);
  console.log('   THESE CALLS DID NOT REACH THE MODEL. The live checks (cv-parse-live) are what prove it still works.');
}
