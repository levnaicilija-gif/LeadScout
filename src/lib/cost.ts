import type { SupabaseClient } from '@supabase/supabase-js';
import { isRecruiterTool } from './ai/tools';

/**
 * What a run costs, recorded as it happens.
 *
 * Prices are Anthropic first-party rates per million tokens, in USD, converted at a fixed
 * rate so a day's spend is comparable over time rather than moving with the exchange rate.
 * Update RATES when Anthropic's pricing changes; update USD_EUR deliberately, not casually.
 */
export const USD_EUR = 0.92;

export const RATES: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5': { in: 1.0, out: 5.0 },
  'claude-sonnet-5': { in: 2.0, out: 10.0 },
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'claude-opus-5': { in: 5.0, out: 25.0 },
};

/** A hosted browser session, priced per minute. Browserless/Browserbase both bill roughly this. */
export const BROWSER_EUR_PER_MIN = 0.02;

export const modelCostEur = (model: string, inTokens: number, outTokens: number) => {
  const r = RATES[model];
  if (!r) return 0;
  return ((inTokens / 1e6) * r.in + (outTokens / 1e6) * r.out) * USD_EUR;
};

/** Daily ceiling for the automated crawl. A run stops rather than exceeding it. */
export const DAILY_BUDGET_EUR = Number(process.env.RADAR_DAILY_BUDGET_EUR ?? 2);

export async function logCost(db: SupabaseClient, workspaceId: string, kind: string, detail: string, units: number, eur: number) {
  await db.from('cost_log').insert({ workspace_id: workspaceId, kind, detail, units, eur });
}

export async function logModelCall(db: SupabaseClient, workspaceId: string, model: string, detail: string, usage: { input_tokens?: number; output_tokens?: number } | undefined) {
  const inT = usage?.input_tokens ?? 0;
  const outT = usage?.output_tokens ?? 0;
  const eur = modelCostEur(model, inT, outT);
  const kind = model.includes('haiku') ? 'haiku' : model.includes('sonnet') ? 'sonnet' : 'model';
  await logCost(db, workspaceId, kind, `${detail} · ${inT}+${outT} tok`, inT + outT, eur);
  return eur;
}

/**
 * Spend recorded in cost_log, in EUR, across every workspace — the crawl is shared infrastructure, so its cap is one
 * system-wide figure. Read with the service role: a signed-in client sees only its own workspace's rows.
 *
 * This was per workspace. On 2026-09-14 a second workspace was created by a sign-up, and a job that picked it would have
 * seen €0 spent and been given another €2.00 for the day. It also read one unpaged query, which stops at 1,000 rows;
 * 10 September logged 944. Every row is now paged in, so the sum cannot quietly fall short.
 */
export async function spentEur(db: SupabaseClient, filter: { day?: string; kind?: string } = {}): Promise<number> {
  let total = 0;
  for (let from = 0; ; from += 1000) {
    let q = db.from('cost_log').select('eur').order('id').range(from, from + 999);
    if (filter.day) q = q.eq('day', filter.day);
    if (filter.kind) q = q.eq('kind', filter.kind);
    const { data, error } = await q;
    // A cap that cannot read what was spent must not report €0 and let a run through.
    if (error) throw new Error(`spend could not be read: ${error.message}`);
    total += (data ?? []).reduce((a, r: any) => a + Number(r.eur ?? 0), 0);
    if (!data || data.length < 1000) return total;
  }
}

/** Spend so far today (UTC), in EUR, across every workspace. */
export async function spentTodayEur(db: SupabaseClient): Promise<number> {
  return spentEur(db, { day: new Date().toISOString().slice(0, 10) });
}

/**
 * Today's spend, system-wide, and the part recruiter tools made (item 16) — recorded and counted, never stopped by the cap.
 * Paged like spentEur, and throws rather than report €0 when it cannot be read.
 */
export async function spentTodaySplit(db: SupabaseClient): Promise<{ total: number; recruiter: number; automated: number }> {
  const day = new Date().toISOString().slice(0, 10);
  const out = { total: 0, recruiter: 0, automated: 0 };
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('cost_log').select('kind, eur').eq('day', day).order('id').range(from, from + 999);
    if (error) throw new Error(`spend could not be read: ${error.message}`);
    for (const r of data ?? []) {
      const eur = Number(r.eur ?? 0);
      out.total += eur;
      if (isRecruiterTool(String(r.kind))) out.recruiter += eur; else out.automated += eur;
    }
    if (!data || data.length < 1000) return out;
  }
}

/** A run-scoped budget: knows what was already spent today, system-wide, and refuses to go past the cap. */
export class Budget {
  private spent = 0;
  constructor(private readonly already: number, readonly capEur: number) {}
  static async open(db: SupabaseClient, capEur = DAILY_BUDGET_EUR) {
    // Never above the daily budget, whatever a caller passes.
    return new Budget(await spentTodayEur(db), Math.min(Number(capEur) || 0, DAILY_BUDGET_EUR));
  }
  get totalToday() { return this.already + this.spent; }
  get remaining() { return Math.max(0, this.capEur - this.totalToday); }
  get exhausted() { return this.remaining <= 0; }
  add(eur: number) { this.spent += eur; }
  /** Would this call take us over? Checked before spending, not after. */
  canAfford(estimateEur: number) { return this.totalToday + estimateEur <= this.capEur; }
}
