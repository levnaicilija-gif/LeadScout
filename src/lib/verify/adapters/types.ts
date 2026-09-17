export type LookupInput = {
  number?: string;
  holder?: string;
  issuer?: string;
  /** Method/process as printed on the certificate — used to pick the right row when a register lists several. */
  method?: string;
  level?: string;
  /** Verification URL/QR printed on the certificate (e.g. an Accredible credential.net link). */
  credentialUrl?: string;
  /** yyyy-mm-dd. Some registers (CSWIP) key on date of birth, not the holder name. */
  dob?: string;
};

/** One certificate row as printed on the issuer's register. Values are copied verbatim from the fetched page. */
export type SourceCertificate = {
  number?: string;
  method?: string;
  level?: string;
  sector?: string;
  scope?: string;
  issued?: string;
  expiry?: string;
};

export type LookupResult = {
  result: 'valid' | 'invalid' | 'not_found' | 'not_supported';
  checkedWhere: string;
  checkedAt: string;
  validUntil?: string;
  holderOnSource?: string;
  screenshot?: Buffer;
  notes?: string;
  /** Every certificate the register showed for this holder, as read from the page. */
  certificates?: SourceCertificate[];
};

export interface Adapter {
  body: string;
  name: string;
  /** Where a recruiter goes to check by hand, and where an unsupported body's issuer can be contacted. */
  issuerUrl: string;
  /**
   * Does this adapter actually search a register, or does it exist to explain that it cannot?
   *
   * DECLARED, never inferred — and required, so a new adapter cannot forget to say. Counting
   * `Object.keys(ADAPTERS)` gave "8 of 16 schemes automatic", which was carried for a session and
   * was wrong: four of those adapters are the captcha, login and company-only registers that never
   * fetch. A second attempt tested for closed.ts's `why` field and found 8 searchable and 0 manual,
   * because that factory keeps `why` in a closure and never puts it on the object. Capability was
   * not readable from the adapter at all until this field existed (2026-09-17).
   */
  searchable: boolean;
  supports(input: LookupInput): boolean;
  lookup(input: LookupInput): Promise<LookupResult>;
}

/** dd/mm/yyyy (as printed by BINDT) → yyyy-mm-dd. Returns undefined rather than guessing. */
export function ukDateToIso(s?: string): string | undefined {
  const m = (s ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return undefined;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
