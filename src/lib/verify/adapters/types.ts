export type LookupInput = { number?: string; holder?: string; issuer?: string };
export type LookupResult = { result: 'valid' | 'invalid' | 'not_found' | 'not_supported'; checkedWhere: string; checkedAt: string; validUntil?: string; holderOnSource?: string; screenshot?: Buffer; notes?: string };
export interface Adapter { body: string; name: string; supports(input: LookupInput): boolean; lookup(input: LookupInput): Promise<LookupResult>; }
