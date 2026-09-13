import { hasRfbtTrades } from './trades';
import { isEuropean, NON_EUROPE_MAX_FIT } from './geo';

/**
 * Fit 0-100: trades x0.4, geography x0.2, timing x0.25, employer type x0.15.
 *
 * Geography is a gate before it is a weight: outside Europe the score is capped at
 * NON_EUROPE_MAX_FIT so a non-European project can never reach Today, however good the trades.
 *
 * One function for every lead source, so a news story and a TED award about the same kind of
 * work score the same way.
 */
export function fitScore(trades: string[], country: string | null | undefined, employer: string, timingMonths: number | null) {
  const t = hasRfbtTrades(trades) ? 1 : 0;
  const european = isEuropean(country);
  const g = european ? 1 : 0;
  const tm = timingMonths == null ? 0.5 : timingMonths <= 12 ? 1 : 0.3;
  const e = employer === 'end_client' || employer === 'epc_contractor' ? 1 : employer === 'unknown' ? 0.5 : 0.3;
  const score = Math.round((t * 0.4 + g * 0.2 + tm * 0.25 + e * 0.15) * 100);
  return european ? score : Math.min(score, NON_EUROPE_MAX_FIT);
}
