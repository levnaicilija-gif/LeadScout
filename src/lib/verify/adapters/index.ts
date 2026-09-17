import { frosio } from './frosio';
import { pcn } from './pcn';
import { cswip } from './cswip';
import { ampp } from './ampp';
import { irata, winda, cisrs, electricalDk } from './closed';
import type { Adapter, LookupInput, LookupResult } from './types';

/**
 * One adapter per certifying body. Searched automatically: `pcn` (BINDT's register), `cswip` (TWI, by number and date of
 * birth), `ampp` (the public registry of current, opted-in holders) and `frosio` (the credential link printed on the
 * certificate). `irata` and `cisrs` sit behind a captcha, `winda` behind a login, and `electrical_dk` has no personal
 * register (Denmark authorises companies) — each says so and never fetches. Checked live 2026-09-15 (item 23).
 */
export const ADAPTERS: Record<string, Adapter> = { frosio, pcn, cswip, ampp, irata, winda, cisrs, electrical_dk: electricalDk };

/** Welder ISO 9606 (DNV/BV/TÜV/LRQA): no public register → issuer email + test-report consistency (see verify route). */
export const ISSUER_EMAIL_BODIES = new Set(['iso9606']);

/**
 * The schemes this app really does search, read from what each adapter declares.
 *
 * Exported so a screen states a counted property rather than a number somebody typed. "8 of 16
 * schemes automatic" rode along for a session as the size of this map; four of its entries exist
 * only to explain that they cannot search. The honest figure is 4 of the 16 schemes CERT_TABLE
 * decodes, with iso9606 checked by asking its issuer instead (scripts/cert-schemes-check.ts).
 */
export const SEARCHABLE_BODIES = new Set(
  Object.values(ADAPTERS).filter((a) => a.searchable).map((a) => a.body),
);

/** How many schemes are searched automatically. Counted, never written down. */
export const searchableCount = () => SEARCHABLE_BODIES.size;

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
