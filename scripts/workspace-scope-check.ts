/**
 * The crawl names its workspace and its cap is system-wide. Read only; in the release gate.
 *
 *   npx tsx --env-file=.env.local scripts/workspace-scope-check.ts
 *
 *   1  No source file picks "the first workspace" (an unordered workspaces limit(1)).
 *   2  crawlWorkspace resolves, to the workspace that owns the crawl's sources.
 *   3  Budget.open / spentTodayEur read every workspace's spend today: the figure equals an exact, paged, unfiltered sum.
 *   4  A caller cannot raise the cap: Budget.open(db, 99) is capped at DAILY_BUDGET_EUR.
 */
import { createClient } from '@supabase/supabase-js';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { crawlWorkspace } from '../src/lib/crawl-workspace';
import { Budget, DAILY_BUDGET_EUR, spentTodayEur } from '../src/lib/cost';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
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
  let exact = 0; const perWs: Record<string, number> = {};
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('cost_log').select('eur, workspace_id').eq('day', day).order('id').range(f, f + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) { exact += Number(r.eur ?? 0); perWs[r.workspace_id] = (perWs[r.workspace_id] ?? 0) + Number(r.eur ?? 0); }
    if (!data || data.length < 1000) break;
  }
  const [today, budget] = await Promise.all([spentTodayEur(db), Budget.open(db)]);
  check(Math.abs(today - exact) < 1e-9 && Math.abs(budget.totalToday - exact) < 1e-9, 'the cap reads spend across every workspace', `exact €${exact.toFixed(4)} · spentTodayEur €${today.toFixed(4)} · Budget €${budget.totalToday.toFixed(4)} · by workspace ${JSON.stringify(Object.fromEntries(Object.entries(perWs).map(([k, v]) => [k.slice(0, 8), Number(v.toFixed(4))])))}`);

  const raised = await Budget.open(db, 99);
  check(raised.capEur === DAILY_BUDGET_EUR, 'a caller cannot raise the cap', `Budget.open(db, 99).capEur = ${raised.capEur}`);

  console.log(failed ? `\n${failed} failed` : '\nworkspace scope: all checks passed');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
