import type { Adapter, LookupInput, LookupResult } from './types';

/**
 * Bodies with NO public register. Checked against the live sites on 2026-09-08.
 *
 * These are real adapters, not placeholders: they exist so Verify tells the recruiter what
 * to do instead of "no adapter for winda". They never fetch and never return a verdict.
 *
 *   winda  https://winda.globalwindsafety.org/  (the spec's winda.globalwindorganisation.org
 *          does not resolve — SSL name mismatch). Every path including /search/ redirects to
 *          /account?ReturnUrl=... with a login form (#Login, #Password, plus an #authCode
 *          2FA field). WINDA records are visible only to the technician and to organisations
 *          the technician has granted access, so a recruiter checks by asking the candidate
 *          to share their WINDA record, or by asking the training provider.
 *
 *   ampp   https://www.ampp.org/resources/impact/certification-search sits behind
 *          HigherLogic OAUTH sign-in; there is no anonymous certification search.
 */
type Closed = { body: string; name: string; issuerUrl: string; why: string; instead: string };

const CLOSED: Closed[] = [
  {
    body: 'winda',
    name: 'WINDA — Global Wind Organisation (winda.globalwindsafety.org)',
    issuerUrl: 'https://winda.globalwindsafety.org/',
    why: 'WINDA has no public search — every page redirects to a login, and records are visible only to the technician and organisations they grant access to',
    instead: 'ask the candidate to share their WINDA record (or their WINDA ID and a screenshot from their own login), or confirm with the training provider that issued the course',
  },
  {
    body: 'ampp',
    name: 'AMPP — Association for Materials Protection and Performance (ampp.org)',
    issuerUrl: 'https://www.ampp.org/resources/impact/certification-search',
    why: 'the AMPP certification search requires an AMPP account sign-in; there is no anonymous lookup',
    instead: 'check with an AMPP member login, or email AMPP certification support with the certificate number and holder',
  },
];

const make = (c: Closed): Adapter => ({
  body: c.body,
  name: c.name,
  issuerUrl: c.issuerUrl,
  supports: () => true,
  async lookup(_i: LookupInput): Promise<LookupResult> {
    return {
      result: 'not_supported',
      checkedWhere: c.issuerUrl,
      checkedAt: new Date().toISOString(),
      notes: `${c.why}. To verify: ${c.instead}.`,
    };
  },
});

export const winda = make(CLOSED[0]);
export const ampp = make(CLOSED[1]);
