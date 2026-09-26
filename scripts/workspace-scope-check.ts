/**
 * The crawl names its workspace and its cap is system-wide. Read only; in the release gate.
 *
 *   npx tsx --env-file=.env.local scripts/workspace-scope-check.ts
 *
 *   1  No source file picks "the first workspace" (an unordered workspaces limit(1)).
 *   2  crawlWorkspace resolves, to the workspace that owns the crawl's sources.
 *   3  Budget.open / spentTodayEur read every workspace's spend today: the figure equals an exact, paged sum of every row
 *      that is not test traffic, and Home's counted and test figures together account for every row.
 *   4  A caller cannot raise the cap: Budget.open(db, 99) is capped at DAILY_BUDGET_EUR.
 */
import { createClient } from '@supabase/supabase-js';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { crawlWorkspace } from '../src/lib/crawl-workspace';
import { Budget, DAILY_BUDGET_EUR, spentTodayEur, spentTodaySplit } from '../src/lib/cost';
import { probeAdmin } from '../src/lib/test-data';

const db = probeAdmin();
let failed = 0;
const check = (ok: boolean, what: string, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); if (!ok) failed++; };

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });

(async () => {
  // A workspace id taken from one unordered row. A column probe picks nothing: test-data.ts reads is_test from any row
  // only to see whether the column exists.
  const AMBIGUOUS = /from\(\s*'workspaces'\s*\)\s*\.select\(\s*'[^']*\bid\b[^']*'\s*\)\s*\.limit\(\s*1\s*\)/;
  const hits = walk('src').filter((f) => AMBIGUOUS.test(readFileSync(f, 'utf8')));
  check(hits.length === 0, 'no job picks "the first workspace"', hits.join(', '));

  const ws = await crawlWorkspace(db).catch((e) => `error: ${e.message}`);
  const { data: owners } = await db.from('sources').select('workspace_id').not('workspace_id', 'is', null).limit(5000);
  const ownerSet = new Set((owners ?? []).map((o: any) => o.workspace_id));
  check(ownerSet.size === 1 && ownerSet.has(ws), 'the crawl files under the workspace that owns its sources', `crawlWorkspace ${ws} · source owners ${[...ownerSet].join(', ')}`);

  const day = new Date().toISOString().slice(0, 10);
  // Test traffic is left out of the cap (owner's decision 2026-09-15). Worked out here on its own — its own read of the test
  // workspaces and its own reading of the meter's mark — so the check does not borrow the rule it is checking.
  const { data: testWsRows, error: testWsError } = await db.from('workspaces').select('id').eq('is_test', true).limit(5000);
  if (testWsError) throw new Error(testWsError.message);
  const testWs = new Set((testWsRows ?? []).map((w: any) => w.id));
  let exact = 0; let all = 0; let testEur = 0; const perWs: Record<string, number> = {};
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('cost_log').select('eur, workspace_id, detail').eq('day', day).order('id').range(f, f + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      const eur = Number(r.eur ?? 0);
      const detail = String(r.detail ?? '');
      all += eur;
      if (detail.startsWith('test workspace') || detail.startsWith('test run (') || (r.workspace_id && testWs.has(r.workspace_id))) { testEur += eur; continue; }
      exact += eur; perWs[r.workspace_id] = (perWs[r.workspace_id] ?? 0) + eur;
    }
    if (!data || data.length < 1000) break;
  }
  const [today, budget, split] = await Promise.all([spentTodayEur(db), Budget.open(db), spentTodaySplit(db)]);
  check(Math.abs(today - exact) < 1e-6 && Math.abs(budget.totalToday - exact) < 1e-6, 'the cap reads spend across every workspace, not test traffic', `counted €${exact.toFixed(4)} · test €${testEur.toFixed(4)} · all €${all.toFixed(4)} · spentTodayEur €${today.toFixed(4)} · Budget €${budget.totalToday.toFixed(4)} · by workspace ${JSON.stringify(Object.fromEntries(Object.entries(perWs).map(([k, v]) => [String(k).slice(0, 8), Number(v.toFixed(4))])))}`);
  check(Math.abs(split.test - testEur) < 1e-6 && Math.abs(split.total + split.test - all) < 1e-6, "Home's figures account for every row: counted plus test is all spend", `Home counted €${split.total.toFixed(4)} + test €${split.test.toFixed(4)} · all €${all.toFixed(4)}`);

  const raised = await Budget.open(db, 99);
  check(raised.capEur === DAILY_BUDGET_EUR, 'a caller cannot raise the cap', `Budget.open(db, 99).capEur = ${raised.capEur}`);

  console.log(failed ? `\n${failed} failed` : '\nworkspace scope: all checks passed');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
