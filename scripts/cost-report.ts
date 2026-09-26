/**
 * What LeadScout costs to run, per tool, from cost_log (item 16).
 *
 *   npx tsx --env-file=.env.local scripts/cost-report.ts [--since 2026-09-15] [--until 2026-09-22] [--after <ISO time>] [--real]
 *
 * One row per tool: who starts it (a recruiter's button, an automated job, or nothing — "unattributed"), attempts logged,
 * EUR, EUR per attempt, and how much of it was test traffic (a probe's workspace, which the row's detail names). Then one
 * row per day against the €2.00 cap, split the same way. --real leaves test traffic out of both tables.
 *
 * Rows written before item 16 name their tool only in the detail (kind 'haiku' / 'sonnet'); they are grouped by the
 * detail's first words. hiring-contacts rows of exactly €0.01 for 1 unit are the flat placeholder it logged per read
 * before item 16, not tokens, and are reported as such. Recruiter tools logged nothing before item 16: a day before it
 * shipped undercounts by whatever recruiters did.
 */
import { createClient } from '@supabase/supabase-js';
import { isRecruiterTool, RECRUITER_TOOLS, UNATTRIBUTED } from '../src/lib/ai/tools';
import { DAILY_BUDGET_EUR, isTestSpend } from '../src/lib/cost';
import { probeAdmin } from '../src/lib/test-data';

const db = probeAdmin();
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const since = arg('--since');
const until = arg('--until');
const after = arg('--after');
const realOnly = process.argv.includes('--real');

const LEGACY: [RegExp, string][] = [
  [/^radar stage1/, 'radar: news extraction'],
  [/^radar job post/, 'radar: job-post page read'],
  [/^job titles/, 'job crawl: advert titles'],
  [/^job body/, 'job crawl: advert body'],
  [/^resolve /, 'website lookup (model)'],
  [/^employer type/, 'employer-type classification'],
  [/^classify \d+ compan/, 'company sector classification'],
  [/^board advert/, 'job boards: advert read'],
  [/^classify-source/, 'source tiering'],
  [/^seed-domain/, 'domain seeding'],
  [/^person search/, 'person search (model)'],
  [/^metering sample/, 'radar: metering sample (scripts/meter-radar-extract.ts)'],
];

type Side = 'recruiter' | 'automated' | 'unattributed';
function toolOf(r: { kind: string; detail: string | null; units: number; eur: number }): { tool: string; side: Side } {
  const detail = String(r.detail ?? '');
  if (isRecruiterTool(r.kind)) return { tool: r.kind, side: 'recruiter' };
  if (r.kind === UNATTRIBUTED) return { tool: UNATTRIBUTED, side: 'unattributed' };
  if (r.kind === 'hiring-contacts') {
    const flat = Number(r.units) === 1 && Math.abs(Number(r.eur) - 0.01) < 1e-9;
    return { tool: flat ? 'hiring-contacts (flat €0.01 placeholder, before item 16)' : 'hiring-contacts: page reads', side: 'automated' };
  }
  if (r.kind === 'search') return { tool: /a person/.test(detail) ? 'web search: a person' : 'web search: a company website', side: 'automated' };
  if (r.kind === 'haiku' || r.kind === 'sonnet' || r.kind === 'model') {
    const hit = LEGACY.find(([re]) => re.test(detail));
    return { tool: hit ? hit[1] : `${r.kind}: ${detail.split(/\s+/).slice(0, 2).join(' ')}`, side: 'automated' };
  }
  return { tool: r.kind, side: 'automated' };
}

(async () => {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from('cost_log').select('id, day, created_at, workspace_id, kind, detail, units, eur').order('id').range(from, from + 999);
    if (since) q = q.gte('day', since);
    if (until) q = q.lte('day', until);
    if (after) q = q.gte('created_at', after);
    const { data, error } = await q;
    if (error) { console.error(`cost_log could not be read: ${error.message}`); process.exit(1); }
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const wsIds = [...new Set(rows.map((r) => r.workspace_id).filter(Boolean))];
  const { data: wss } = wsIds.length ? await db.from('workspaces').select('id, is_test').in('id', wsIds) : { data: [] as any[] };
  const testWs = new Set((wss ?? []).filter((w: any) => w.is_test).map((w: any) => w.id));
  // The cap's own rule, so the report's "counted" is exactly what the cap counted.
  const isTest = (r: any) => isTestSpend(r, testWs);
  const used = rows.filter((r) => !realOnly || !isTest(r));

  const tools = new Map<string, { side: Side; n: number; eur: number; testEur: number; testN: number }>();
  for (const r of used) {
    const { tool, side } = toolOf(r);
    const t = tools.get(tool) ?? { side, n: 0, eur: 0, testEur: 0, testN: 0 };
    t.n++; t.eur += Number(r.eur ?? 0);
    if (isTest(r)) { t.testN++; t.testEur += Number(r.eur ?? 0); }
    tools.set(tool, t);
  }
  const span = `${since ?? (used[0]?.day ?? '—')} to ${until ?? (used.at(-1)?.day ?? '—')}${after ? `, logged after ${after}` : ''}${realOnly ? ', test traffic left out' : ''}`;
  console.log(`cost_log, ${span}: ${used.length} rows, €${used.reduce((a, r) => a + Number(r.eur ?? 0), 0).toFixed(4)}\n`);
  console.log(`${'tool'.padEnd(58)} ${'started by'.padEnd(12)} ${'attempts'.padStart(8)} ${'EUR'.padStart(9)} ${'EUR/attempt'.padStart(11)}  of which test`);
  for (const [tool, t] of [...tools.entries()].sort((a, b) => b[1].eur - a[1].eur)) {
    const label = isRecruiterTool(tool) ? `${tool} — ${RECRUITER_TOOLS[tool]}` : tool;
    console.log(`${label.slice(0, 58).padEnd(58)} ${t.side.padEnd(12)} ${String(t.n).padStart(8)} ${t.eur.toFixed(4).padStart(9)} ${(t.eur / t.n).toFixed(5).padStart(11)}  ${t.testN ? `${t.testN} · €${t.testEur.toFixed(4)}` : '—'}`);
  }

  // "counted" is what the cap counts; test traffic is its own column and is not part of it (owner's decision 2026-09-15).
  const days = new Map<string, Record<Side | 'counted' | 'test', number>>();
  for (const r of used) {
    const d = days.get(r.day) ?? { counted: 0, recruiter: 0, automated: 0, unattributed: 0, test: 0 };
    const eur = Number(r.eur ?? 0);
    if (isTest(r)) d.test += eur;
    else { d.counted += eur; d[toolOf(r).side] += eur; }
    days.set(r.day, d);
  }
  console.log(`\n${'day'.padEnd(12)} ${'counted'.padStart(8)} ${'of cap'.padStart(7)} ${'recruiter'.padStart(10)} ${'automated'.padStart(10)} ${'unattrib.'.padStart(10)} ${'test, not counted'.padStart(18)}`);
  for (const [day, d] of [...days.entries()].sort()) {
    console.log(`${day.padEnd(12)} ${d.counted.toFixed(4).padStart(8)} ${`${Math.round((d.counted / DAILY_BUDGET_EUR) * 100)}%`.padStart(7)} ${d.recruiter.toFixed(4).padStart(10)} ${d.automated.toFixed(4).padStart(10)} ${d.unattributed.toFixed(4).padStart(10)} ${d.test.toFixed(4).padStart(18)}`);
  }
})();
