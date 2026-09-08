export type LookupInput = {
  number?: string;
  holder?: string;
  issuer?: string;
  /** Method/process as printed on the certificate — used to pick the right row when a register lists several. */
  method?: string;
  level?: string;
  /** Verification URL/QR printed on the certificate (e.g. an Accredible credential.net link). */
  credentialUrl?: string;
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
  supports(input: LookupInput): boolean;
  lookup(input: LookupInput): Promise<LookupResult>;
}

/** dd/mm/yyyy (as printed by BINDT) → yyyy-mm-dd. Returns undefined rather than guessing. */
export function ukDateToIso(s?: string): string | undefined {
  const m = (s ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return undefined;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
