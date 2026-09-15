import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { modelCostEur, RATES } from '../cost';
import { UNATTRIBUTED, type RecruiterTool } from './tools';

/**
 * Every model call a recruiter's button makes, logged to cost_log with its model, tokens and EUR (item 16).
 *
 * Until 2026-09-15 only the crawl logged: CV parsing, bullets, scoring, job descriptions, questions, outreach drafts,
 * the PII review, Verify's document read and the anonymiser all spent without a row, so "Spent today" and the €2.00 cap
 * undercounted by whatever recruiters did that day.
 *
 * Two scopes, carried through the request without threading a parameter through every function:
 *   - the request: `meterRecruiter(me, fn)` in each route — which workspace, which person;
 *   - the tool: `asTool('cv-parse', fn)` in documents.ts — the innermost name wins, so bullets' audit logs as its own tool.
 * askJson and createMessage read both and log every attempt, a failed first attempt included. A call with neither is
 * still logged — workspace empty, kind 'unattributed' — so a gap in the wiring shows up as a row, never as missing spend.
 *
 * Recording never blocks and never throws: a recruiter's tool is not stopped by the cap (owner's decision) or by a failed
 * insert, which is printed instead. Automated jobs meter through their own Budget and stop at the cap.
 */
type Request = { db: SupabaseClient; workspaceId: string; userId: string };

const requestScope = new AsyncLocalStorage<Request>();
const toolScope = new AsyncLocalStorage<RecruiterTool>();

let admin: SupabaseClient | null = null;
/** The service role, with no Data Cache (see supabaseAdmin). Built here so scripts, which cannot import next/headers, log too. */
function serviceDb(): SupabaseClient {
  admin ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
    global: { fetch: (input: any, init?: any) => fetch(input, { ...init, cache: 'no-store' }) },
  });
  return admin;
}

/** Run a signed-in recruiter's request with its model calls logged against their workspace. */
export function meterRecruiter<T>(me: { id: string; workspace_id: string }, fn: () => Promise<T>, db?: SupabaseClient): Promise<T> {
  return requestScope.run({ db: db ?? serviceDb(), workspaceId: me.workspace_id, userId: me.id }, fn);
}

/** Name the tool for every model call inside fn. */
export function asTool<T>(tool: RecruiterTool, fn: () => Promise<T>): Promise<T> {
  return toolScope.run(tool, fn);
}

const testWorkspace = new Map<string, Promise<boolean>>();
/** A probe's workspace is marked is_test (0020). Its spend is real and stays in the total; the row says it was a test. */
function isTest(db: SupabaseClient, workspaceId: string): Promise<boolean> {
  if (!testWorkspace.has(workspaceId)) {
    testWorkspace.set(workspaceId, Promise.resolve(db.from('workspaces').select('is_test').eq('id', workspaceId).maybeSingle())
      .then(({ data, error }) => !error && data?.is_test === true, () => false));
  }
  return testWorkspace.get(workspaceId)!;
}

/** The cost_log row for one attempt. Pure, so model-meter-check can hold it to its shape. */
export function usageRow(input: { tool: string; model: string; usage?: { input_tokens?: number; output_tokens?: number }; workspaceId: string | null; userId: string | null; test: boolean }) {
  const inT = input.usage?.input_tokens ?? 0;
  const outT = input.usage?.output_tokens ?? 0;
  const detail = [
    input.test ? 'test workspace' : null,
    input.userId ? `by ${input.userId}` : 'no signed-in request',
    input.model,
    `${inT}+${outT} tok`,
  ].filter(Boolean).join(' · ');
  return { workspace_id: input.workspaceId, kind: input.tool, detail, units: inT + outT, eur: modelCostEur(input.model, inT, outT) };
}

/**
 * Insert one cost_log row, retried once a second later. On 2026-09-15 the release gate's pdf-check lost a €0.0026 PII review
 * to a single "fetch failed" while the next insert went through. A retry after a reply lost in transit can log a row
 * twice; spend read slightly high is the safe side of a cap, spend missing is not.
 */
async function insertRow(db: SupabaseClient, row: ReturnType<typeof usageRow>): Promise<string | null> {
  let problem = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { error } = await db.from('cost_log').insert(row);
      if (!error) return null;
      problem = error.message;
    } catch (e: any) {
      problem = String(e?.message ?? e);
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, 1000));
  }
  return problem;
}

/** Log one attempt's usage under the current request and tool. Returns its EUR. Never throws. */
export async function recordUsage(model: string, usage: { input_tokens?: number; output_tokens?: number } | undefined): Promise<number> {
  const req = requestScope.getStore();
  const tool = toolScope.getStore() ?? UNATTRIBUTED;
  if (!RATES[model]) console.error(`[meter] no rate for ${model}: ${tool} logs €0 — add it to RATES in src/lib/cost.ts`);
  try {
    const db = req?.db ?? serviceDb();
    const row = usageRow({ tool, model, usage, workspaceId: req?.workspaceId ?? null, userId: req?.userId ?? null, test: req ? await isTest(db, req.workspaceId) : false });
    const problem = await insertRow(db, row);
    if (problem) console.error(`[meter] ${tool} €${row.eur.toFixed(4)} was not recorded after a retry: ${problem}`);
    return row.eur;
  } catch (e: any) {
    console.error(`[meter] ${tool} was not recorded: ${String(e?.message ?? e)}`);
    return modelCostEur(model, usage?.input_tokens ?? 0, usage?.output_tokens ?? 0);
  }
}

/**
 * An automated job's meter: the real tokens of every attempt, logged under the job's own kind and added to its Budget,
 * which the job checks before each call. Replaces the flat €0.01 hiring-contacts logged per read.
 */
export function jobMeter(db: SupabaseClient, workspaceId: string, budget: { add(eur: number): void }, kind: string, what: string) {
  return async (usage: { input_tokens?: number; output_tokens?: number } | undefined, model: string) => {
    const row = usageRow({ tool: kind, model, usage, workspaceId, userId: null, test: false });
    row.detail = `${what} · ${row.detail.replace(/^no signed-in request · /, '')}`;
    budget.add(row.eur);
    const problem = await insertRow(db, row);
    if (problem) console.error(`[meter] ${kind} €${row.eur.toFixed(4)} was not recorded after a retry: ${problem}`);
  };
}
