/**
 * IS THERE ROOM IN TODAY'S TEST BUDGET? Exit 0 yes, exit 2 spent, exit 1 could not tell. Read-only.
 *
 *   npx tsx --env-file=.env.local scripts/test-budget-check.ts
 *
 * Test traffic — gates, probes, smoke — was 61% of thirty days of model spend to 2026-10-07: $77.69 of
 * $127.55, against $46.90 of real automated work and $2.96 of actual recruiter sessions. There was no ceiling
 * on it at all, because the €2.00 daily cap deliberately EXCLUDES test spend (item 16) so that a gate cannot
 * starve the crawl. That protection left test spend completely unbounded in the other direction.
 *
 * THE DEFAULT IS $5.00, CHOSEN FROM THE DATA RATHER THAN PICKED. Measured over the 28 days in that window
 * that have rows: test spend exceeded $5.00 on SIX of them — Sep 15 $10.72, Sep 24 $5.07, Sep 25 $5.12,
 * Sep 26 $11.29, Sep 27 $7.09, Sep 28 $5.10 — and every one of those was a day of eight or more gate runs.
 * It is about eight full gates at the measured $0.58, so it bounds the runaway day without interrupting
 * ordinary work. A tighter $3.00 would have bitten on twelve of twenty-eight days, which is a budget that
 * trains people to override it.
 *
 * IT NEVER FAILS SILENTLY. Exit 2 is "spent", which release-gate.sh turns into a NAMED skip of the
 * model-calling probes — the same shape as memory-preflight — so a cheap gate always says why it was cheap.
 * And it never guesses: a spend figure it cannot read is exit 1, not exit 0, because treating an unreadable
 * total as "plenty of room" is how a cap stops being one.
 */
import { probeAdmin } from '../src/lib/test-data';
import { isTestSpend } from '../src/lib/cost';

const USD_PER_EUR = 1.16;
const BUDGET_USD = Number(process.env.TEST_BUDGET_USD ?? 5.0);

(async () => {
  if (!Number.isFinite(BUDGET_USD) || BUDGET_USD <= 0) {
    console.log(`TEST_BUDGET_USD is "${process.env.TEST_BUDGET_USD}", which is not a positive number — refusing to judge`);
    process.exitCode = 1;
    return;
  }
  const db = probeAdmin();
  // The UTC day comes from the DATABASE. This machine's clock has read hours stale after sleeping, and a
  // budget keyed on the wrong day is no budget.
  const probe = await db.from('cost_log').insert({ kind: 'fetch', detail: 'test-budget clock probe (no spend)', eur: 0 }).select('id, day').single();
  if (probe.error) {
    console.log('the day could not be read from the database: ' + probe.error.message.slice(0, 90));
    console.log('REFUSING TO JUDGE — an unreadable total must never read as "room available"');
    process.exitCode = 1;
    return;
  }
  await db.from('cost_log').delete().eq('id', probe.data.id);
  const today = String(probe.data.day);

  const { data, error } = await db.from('cost_log').select('kind, detail, eur, workspace_id').eq('day', today).limit(5000);
  if (error) {
    console.log('today\'s spend could not be read: ' + error.message.slice(0, 90));
    console.log('REFUSING TO JUDGE — an unreadable total must never read as "room available"');
    process.exitCode = 1;
    return;
  }
  const rows = data ?? [];
  const wsIds = [...new Set(rows.map((r) => r.workspace_id).filter((x): x is string => !!x))];
  const tests = new Set<string>();
  for (let i = 0; i < wsIds.length; i += 200) {
    const { data: w, error: wErr } = await db.from('workspaces').select('id, is_test').in('id', wsIds.slice(i, i + 200));
    if (wErr) {
      console.log('the test workspaces could not be read: ' + wErr.message.slice(0, 80));
      console.log('REFUSING TO JUDGE — half a classification is not a total');
      process.exitCode = 1;
      return;
    }
    for (const x of w ?? []) if (x.is_test) tests.add(x.id);
  }

  const testRows = rows.filter((r) => isTestSpend(r, tests));
  const spentUsd = testRows.reduce((a, r) => a + (Number(r.eur) || 0), 0) * USD_PER_EUR;
  const left = BUDGET_USD - spentUsd;
  console.log(`test budget ${today}: $${spentUsd.toFixed(2)} spent of $${BUDGET_USD.toFixed(2)} over ${testRows.length} call(s)`);
  if (left <= 0) {
    console.log(`SPENT — the model-calling probes will be SKIPPED. Raise it for this run with TEST_BUDGET_USD=<n>, or run them tomorrow.`);
    console.log(`   a full gate is about $0.58, so $${BUDGET_USD.toFixed(2)} is roughly ${Math.floor(BUDGET_USD / 0.58)} of them.`);
    process.exitCode = 2;
    return;
  }
  console.log(`room: $${left.toFixed(2)} — about ${Math.floor(left / 0.58)} more full gate(s) at the measured $0.58`);
})();
