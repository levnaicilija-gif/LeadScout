import { frosio } from './frosio';
import { pcn } from './pcn';
import type { Adapter, LookupInput, LookupResult } from './types';
/** Bodies with a public register get a browser adapter. Add cswip, ampp, irata, winda, cisrs, electrical_dk here (same shape). */
export const ADAPTERS: Record<string, Adapter> = { frosio, pcn };
/** Welder ISO 9606 (DNV/BV/TÜV/LRQA): no public register → issuer email + test-report consistency (see verify route). */
export const ISSUER_EMAIL_BODIES = new Set(['iso9606']);
export async function runLookup(body: string, input: LookupInput): Promise<LookupResult> {
  const a = ADAPTERS[body];
  if (!a || !a.supports(input)) return { result: 'not_supported', checkedWhere: '', checkedAt: new Date().toISOString(), notes: `No lookup adapter for ${body}` };
  return a.lookup(input);
}
