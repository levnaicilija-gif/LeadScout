import type { SupabaseClient } from '@supabase/supabase-js';

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

/** Spend so far today, in EUR. */
export async function spentTodayEur(db: SupabaseClient, workspaceId: string): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const { data } = await db.from('cost_log').select('eur').eq('workspace_id', workspaceId).eq('day', day);
  return (data ?? []).reduce((a, r: any) => a + Number(r.eur ?? 0), 0);
}

/** A run-scoped budget: knows what was already spent today and refuses to go past the cap. */
export class Budget {
  private spent = 0;
  constructor(private readonly already: number, readonly capEur: number) {}
  static async open(db: SupabaseClient, workspaceId: string, capEur = DAILY_BUDGET_EUR) {
    return new Budget(await spentTodayEur(db, workspaceId), capEur);
  }
  get totalToday() { return this.already + this.spent; }
  get remaining() { return Math.max(0, this.capEur - this.totalToday); }
  get exhausted() { return this.remaining <= 0; }
  add(eur: number) { this.spent += eur; }
  /** Would this call take us over? Checked before spending, not after. */
  canAfford(estimateEur: number) { return this.totalToday + estimateEur <= this.capEur; }
}
