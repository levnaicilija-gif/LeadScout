/**
 * Item 16: every model call is metered. In the release gate; no network, no model call.
 *
 *   npx tsx scripts/model-meter-check.ts
 *
 * Static — read off the source, so a new call site cannot slip in unlogged:
 *   - every API route that imports the recruiter tools (src/lib/ai/documents.ts) runs them inside meterRecruiter;
 *   - every askJson and createMessage in documents.ts sits inside asTool with a name from RECRUITER_TOOLS, and every name
 *     is used;
 *   - a raw claude.messages.create anywhere else in src is followed by logModelCall within ten lines;
 *   - an askJson outside documents.ts passes a meter (onUsage, or jobMeter), no flat €0.01 stands in for a read's tokens,
 *     and every automated job route that calls the model opens the daily Budget.
 * Behaviour — against a fake database:
 *   - a recruiter's call logs kind = tool, their workspace, "by <user>", the model, the tokens and the rate's EUR;
 *   - the innermost tool names the call, and two requests running at once never log under each other's workspace;
 *   - a test workspace's row says so; a call with no request logs no workspace and "no signed-in request";
 *   - a job's meter logs its own kind and adds the EUR to its budget.
 */
import fs from 'node:fs';
import path from 'node:path';
import { meterRecruiter, asTool, recordUsage, usageRow, jobMeter } from '../src/lib/ai/meter';
import { RECRUITER_TOOLS, UNATTRIBUTED } from '../src/lib/ai/tools';
import { modelCostEur, isTestSpend } from '../src/lib/cost';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };

const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
});
const files = walk('src').map((f) => ({ f: f.replace(/\\/g, '/'), s: fs.readFileSync(f, 'utf8') }));

/** The text of a call from its opening parenthesis to the matching close; strings and templates are skipped over. */
function callText(s: string, at: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = s.indexOf('(', at); i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')' && --depth === 0) return s.slice(at, i + 1);
  }
  return s.slice(at);
}

(async () => {
  console.log('Static: where the model is called');
  const toolRoutes = files.filter(({ f, s }) => f.startsWith('src/app/api/') && /from '@\/lib\/ai\/documents'/.test(s) && /\b(extractDocument|parseCv|transcribeCv|buildBullets|clientSummary|scoreAgainstJob|scoreWithRightToWork|piiModelReview|jdFromLead|screeningQuestions|candidateScreening|draftOutreachChecked|draftOutreach|checkDraft|checkBullets|clientBullets)\(/.test(s));
  for (const { f, s } of toolRoutes) check(/return meterRecruiter\(me, \(\) => handle\(req, me\)\)/.test(s), `${f} runs the recruiter tools inside meterRecruiter`);
  check(toolRoutes.length >= 7, `the recruiter routes were found (${toolRoutes.length}: ${toolRoutes.map((r) => r.f.replace('src/app/api/', '').replace('/route.ts', '')).join(', ')})`);

  const docs = files.find((x) => x.f === 'src/lib/ai/documents.ts')!.s;
  const asks = (docs.match(/askJson\(/g) ?? []).length;
  const creates = (docs.match(/createMessage\(/g) ?? []).length;
  const named = [...docs.matchAll(/asTool\('([a-z-]+)'/g)].map((m) => m[1]);
  const wrappedAsks = (docs.match(/asTool\('[a-z-]+', \(\) => askJson\(/g) ?? []).length;
  check(asks > 0 && asks === wrappedAsks, `every askJson in documents.ts is inside asTool`, `${wrappedAsks} of ${asks}`);
  check(creates === 2 && /asTool\('document-read', \(\) => readDocument\(/.test(docs) && /asTool\('cv-transcribe', async \(\) => \{\n\s+const r = await createMessage\(/.test(docs), 'both createMessage calls in documents.ts are named (document-read, cv-transcribe)', `${creates} createMessage`);
  check(!/claude\.messages\.create/.test(docs), 'documents.ts makes no raw, unlogged call');
  const unknown = named.filter((n) => !(n in RECRUITER_TOOLS));
  const unused = Object.keys(RECRUITER_TOOLS).filter((k) => !named.includes(k));
  check(!unknown.length && !unused.length, 'every tool name is in RECRUITER_TOOLS and every entry is used', [unknown.length ? `unknown: ${unknown}` : '', unused.length ? `unused: ${unused}` : ''].filter(Boolean).join('; '));

  for (const { f, s } of files) {
    if (f === 'src/lib/ai/claude.ts') continue;
    for (const m of s.matchAll(/claude\.messages\.create\(/g)) {
      const line = s.slice(0, m.index).split('\n').length;
      const after = s.split('\n').slice(line - 1, line + 10).join('\n');
      check(/logModelCall\(/.test(after), `${f}:${line} logs the raw call it makes`);
    }
    if (f === 'src/lib/ai/documents.ts') continue;
    for (const m of s.matchAll(/(?<![\w.])askJson\(/g)) {
      const line = s.slice(0, m.index).split('\n').length;
      if (/export async function askJson/.test(s.split('\n')[line - 1])) continue;
      check(/onUsage|jobMeter\(/.test(callText(s, m.index!)), `${f}:${line} passes a meter to askJson`);
    }
  }
  const flat = files.filter(({ s }) => /logCost\([^;]*,\s*1,\s*0\.01\)/.test(s)).map(({ f }) => f);
  check(!flat.length, 'no flat €0.01 is logged in place of a read\'s tokens', flat.join(', '));
  const uncapped = files.filter(({ f, s }) => /^src\/app\/api\/jobs\/[^/]+\/route\.ts$/.test(f) && /claude\.messages\.create\(|askJson\(/.test(s) && !/Budget\.open\(/.test(s)).map(({ f }) => f);
  check(!uncapped.length, 'every automated job that calls the model opens the daily Budget', uncapped.join(', '));

  console.log('\nBehaviour: what a metered call writes');
  const rows: any[] = [];
  const tests = new Set(['ws-test']);
  const fakeDb: any = {
    from: (table: string) => table === 'cost_log'
      ? { insert: async (row: any) => { rows.push(row); return { error: null }; } }
      : { select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: { is_test: tests.has(id) }, error: null }) }) }) },
  };
  const usage = { input_tokens: 1200, output_tokens: 300 };
  const model = 'claude-sonnet-5';

  await meterRecruiter({ id: 'user-a', workspace_id: 'ws-a' }, () => asTool('cv-parse', () => recordUsage(model, usage)), fakeDb);
  const r0 = rows[0];
  check(r0?.kind === 'cv-parse' && r0.workspace_id === 'ws-a', 'a recruiter call logs its tool as kind and their workspace', JSON.stringify(r0));
  check(r0?.units === 1500 && Math.abs(r0.eur - modelCostEur(model, 1200, 300)) < 1e-12 && r0.eur > 0, 'tokens are units and EUR is the model rate', `€${r0?.eur}`);
  check(r0?.detail === `by user-a · ${model} · 1200+300 tok`, 'the detail names the person, model and tokens', r0?.detail);

  rows.length = 0;
  await meterRecruiter({ id: 'user-a', workspace_id: 'ws-a' }, () => asTool('bullets', async () => { await recordUsage(model, usage); await asTool('bullets-audit', () => recordUsage(model, usage)); await recordUsage(model, usage); }), fakeDb);
  check(rows.map((r) => r.kind).join(',') === 'bullets,bullets-audit,bullets', 'the innermost tool names each call', rows.map((r) => r.kind).join(','));

  rows.length = 0;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await Promise.all([
    meterRecruiter({ id: 'user-a', workspace_id: 'ws-a' }, () => asTool('job-description', async () => { await pause(30); await recordUsage(model, usage); }), fakeDb),
    meterRecruiter({ id: 'user-b', workspace_id: 'ws-b' }, () => asTool('outreach-draft', async () => { await pause(5); await recordUsage(model, usage); await pause(40); await recordUsage(model, usage); }), fakeDb),
  ]);
  const crossed = rows.filter((r) => (r.workspace_id === 'ws-a') !== (r.kind === 'job-description') || (r.workspace_id === 'ws-a') !== r.detail.includes('user-a'));
  check(rows.length === 3 && crossed.length === 0, 'two requests at once never log under each other', rows.map((r) => `${r.kind}@${r.workspace_id}`).join(', '));

  rows.length = 0;
  await meterRecruiter({ id: 'probe', workspace_id: 'ws-test' }, () => asTool('pii-review', () => recordUsage(model, usage)), fakeDb);
  check(rows[0]?.detail.startsWith('test workspace · by probe'), "a test workspace's row says so", rows[0]?.detail);

  const loose = usageRow({ tool: UNATTRIBUTED, model, usage, workspaceId: null, userId: null, test: false });
  check(loose.workspace_id === null && loose.kind === 'unattributed' && loose.detail === `no signed-in request · ${model} · 1200+300 tok` && loose.eur > 0, 'a call with no request still logs its EUR, with no workspace', loose.detail);

  rows.length = 0;
  let added = 0;
  await jobMeter(fakeDb, 'ws-a', { add: (e) => { added += e; } }, 'hiring-contacts', 'organisation page at Aibel')(usage, 'claude-haiku-4-5');
  const j = rows[0];
  check(j?.kind === 'hiring-contacts' && j.detail === 'organisation page at Aibel · claude-haiku-4-5 · 1200+300 tok' && Math.abs(added - j.eur) < 1e-12 && j.eur === modelCostEur('claude-haiku-4-5', 1200, 300), "a job's meter logs real tokens under its kind and adds them to its budget", `${j?.detail} €${j?.eur}`);

  rows.length = 0;
  let refusals = 1;
  const flaky: any = { from: () => ({ insert: async (row: any) => { if (refusals-- > 0) throw new TypeError('fetch failed'); rows.push(row); return { error: null }; } }) };
  await jobMeter(flaky, 'ws-a', { add: () => {} }, 'hiring-contacts', 'retry')(usage, 'claude-haiku-4-5');
  check(rows.length === 1, 'a recording that fails once in transit is retried and kept', `${rows.length} row(s)`);

  // Test traffic is logged but kept out of the cap (owner's decision 2026-09-15).
  const scripted = usageRow({ tool: 'pii-review', model, usage, workspaceId: null, userId: null, test: false, testRun: 'pdf-check' });
  check(scripted.detail === `test run (pdf-check) · no signed-in request · ${model} · 1200+300 tok`, "a gate script's call outside a request is marked a test run", scripted.detail);
  const noTestWs = new Set<string>();
  const testWs = new Set(['ws-test']);
  check(isTestSpend({ detail: 'test workspace · by probe · x' }, noTestWs) && isTestSpend({ detail: scripted.detail }, noTestWs) && isTestSpend({ detail: 'by user-a · x', workspace_id: 'ws-test' }, testWs),
    "test spend is told by the meter's mark or by a test workspace");
  check(!isTestSpend({ detail: `by user-a · ${model} · 1+1 tok`, workspace_id: 'ws-a' }, testWs) && !isTestSpend({ detail: 'radar stage1 contest workspace', workspace_id: null }, testWs) && !isTestSpend({ detail: null, workspace_id: null }, testWs),
    'production spend is never taken for test spend');

  console.log(failures === 0 ? '\nmodel meter check: all checks passed' : `\nmodel meter check: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
