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
 *
 *   cisrs  cisrs.org.uk has no card checker of its own (every /card-check path is a 404).
 *          CISRS cards are checked through CSCS Smart Check, which does list CISRS among
 *          its 40 schemes — but cardchecker.cscsonline.uk.com gates every lookup behind
 *          reCAPTCHA ("v3 score below threshold, please complete v2 captcha"). That is a
 *          deliberate access control, so this adapter does not automate it; the recruiter
 *          checks the card by hand or in the CSCS Smart Check app.
 *
 *   electrical_dk
 *          Denmark does not certify individual electricians. Sikkerhedsstyrelsen issues a
 *          company authorisation (virksomhedsautorisation) and approves a named "fagligt
 *          ansvarlig" for that company, so there is no personal register a candidate's
 *          credential can be looked up in. Note the authority's live host is www.sik.dk —
 *          both sikkerhedsstyrelsen.dk names currently serve invalid certificates
 *          (www.sikkerhedsstyrelsen.dk presents a self-signed cert for the internal name
 *          "em-sik-pweb02"), so the URL in the build spec cannot be fetched at all.
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
  {
    body: 'cisrs',
    name: 'CISRS scaffolding — checked via CSCS Smart Check',
    issuerUrl: 'https://www.cscssmartcheck.co.uk/',
    why: 'CISRS has no card checker on its own site, and CSCS Smart Check — which does cover CISRS — puts a reCAPTCHA in front of every lookup, so it cannot be checked automatically',
    instead: 'check the card at cscssmartcheck.co.uk (scheme "CISRS", registration number + last name) or in the CSCS Smart Check app, and save the screenshot',
  },
  {
    body: 'electrical_dk',
    name: 'Danish electrical authorisation — Sikkerhedsstyrelsen (sik.dk)',
    issuerUrl: 'https://www.sik.dk/erhverv/elinstallationer-og-elanlaeg/autorisation',
    why: 'Denmark authorises the company (virksomhedsautorisation) and approves a named responsible person for it, so an individual electrician has no personal certificate in a public register',
    instead: "check the employing company's authorisation with Sikkerhedsstyrelsen, and treat the electrician's own qualification as a trade certificate to confirm with the issuing school or employer",
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

const byBody = Object.fromEntries(CLOSED.map((c) => [c.body, make(c)]));
export const winda = byBody.winda;
export const ampp = byBody.ampp;
export const cisrs = byBody.cisrs;
export const electricalDk = byBody.electrical_dk;
