import { frosio } from './frosio';
import { pcn } from './pcn';
import { cswip } from './cswip';
import { irata } from './irata';
import { winda, ampp } from './closed';
import type { Adapter, LookupInput, LookupResult } from './types';

/**
 * One adapter per certifying body. `frosio`, `winda` and `ampp` have no public register and
 * say so instead of guessing; the rest search a real one. Still to add: cisrs, electrical_dk.
 */
export const ADAPTERS: Record<string, Adapter> = { frosio, pcn, cswip, irata, winda, ampp };

/** Welder ISO 9606 (DNV/BV/TÜV/LRQA): no public register → issuer email + test-report consistency (see verify route). */
export const ISSUER_EMAIL_BODIES = new Set(['iso9606']);

export async function runLookup(body: string, input: LookupInput): Promise<LookupResult> {
  const a = ADAPTERS[body];
  const checkedAt = new Date().toISOString();
  if (!a) return { result: 'not_supported', checkedWhere: '', checkedAt, notes: `No lookup adapter for ${body}` };
  if (!a.supports(input)) {
    // The adapter exists but cannot search on what we extracted — say why, and where to go by hand.
    return { result: 'not_supported', checkedWhere: a.issuerUrl, checkedAt, notes: `${a.name}: not enough on the certificate to search (need a certificate/registry number or holder name)` };
  }
  try {
    return await a.lookup(input);
  } catch (e: any) {
    // A failed fetch is never a verdict about the certificate.
    return { result: 'not_supported', checkedWhere: a.issuerUrl, checkedAt, notes: `${a.name} lookup failed: ${e?.message ?? e}` };
  }
}

export type { Adapter, LookupInput, LookupResult } from './types';
