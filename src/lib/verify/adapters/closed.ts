import type { Adapter, LookupInput, LookupResult } from './types';

/**
 * Bodies with NO register this app may search automatically. Checked against the live sites on 2026-09-08 and again on
 * 2026-09-15 (item 23). The owner's rule: a register behind a captcha or a login stays manual — never automated around.
 *
 * These are real adapters, not placeholders: they exist so Verify tells the recruiter what to do instead of "no adapter
 * for winda". They never fetch and never return a verdict.
 *
 *   irata  https://techconnect.irata.org/verify/tech is public, but every search is sent with a reCAPTCHA v3 token
 *          (`window.sendWithRecaptcha` → grecaptcha.execute(site key 6LclgYoo…) → "g-recaptcha-response"). Until
 *          2026-09-15 this adapter drove a hosted browser through it; that is automating past an access control, so it
 *          was retired. A person checks by hand and saves IRATA's Verified Certification Report.
 *
 *   winda  https://winda.globalwindsafety.org/ is a login (with a 2FA field). GWO: only organisations with a WINDA
 *          profile see a technician's training records, using the WINDA ID the technician gives them.
 *
 *   cisrs  cisrs.org.uk has no card checker. CSCS Smart Check (cscssmartcheck.co.uk, a JavaScript app) answers
 *          CAPTCHA_REQUIRED and keeps its API for approved IT partners; NOCN's Online Card Checker
 *          (cardchecker.nocn.org), the other checker naming CISRS, loads Google reCAPTCHA.
 *
 *   electrical_dk
 *          Denmark authorises the company, not the electrician. Erhvervsstyrelsen's autorisationsregister
 *          (https://www.sik.dk/registre/autorisationsregister, CSV at /registries/export/csv/autorisationsregister — 10,250
 *          rows, 4,721 electrical, columns navn, adresse1–3, landkode, postnr, postdst, cvr, autnr, forretningsomr,
 *          binavn) is public and lists companies only, so it can confirm an employer's authorisation and never a
 *          candidate's own.
 */
type Closed = { body: string; name: string; issuerUrl: string; why: string; instead: string };

const CLOSED: Closed[] = [
  {
    body: 'irata',
    name: 'IRATA — Technician Verification (techconnect.irata.org)',
    issuerUrl: 'https://techconnect.irata.org/verify/tech',
    why: "IRATA's verification tool sends a reCAPTCHA token with every search, so it is not searched automatically",
    instead: 'open techconnect.irata.org/verify/tech, enter the IRATA number and surname, and save the Verified Certification Report it offers',
  },
  {
    body: 'winda',
    name: 'WINDA — Global Wind Organisation (winda.globalwindsafety.org)',
    issuerUrl: 'https://winda.globalwindsafety.org/',
    why: 'WINDA has no public search — records are visible only to organisations with a WINDA profile, using the WINDA ID the technician gives them',
    instead: 'ask the candidate for their WINDA ID and to share their record, or confirm with the training provider that issued the course',
  },
  {
    body: 'cisrs',
    name: 'CISRS scaffolding — checked via CSCS Smart Check',
    issuerUrl: 'https://www.cscssmartcheck.co.uk/',
    why: 'CISRS has no card checker of its own, and both checkers that cover it (CSCS Smart Check and NOCN\'s Online Card Checker) put a captcha in front of every lookup',
    instead: 'check the card in CSCS Smart Check (scheme "CISRS", registration number + surname) and save the screenshot',
  },
  {
    body: 'electrical_dk',
    name: 'Danish electrical authorisation — Erhvervsstyrelsen autorisationsregister (sik.dk)',
    issuerUrl: 'https://www.sik.dk/registre/autorisationsregister',
    why: "Denmark authorises the company, not the electrician: the public autorisationsregister lists authorised companies and no individual, so a person's authorisation cannot be looked up",
    instead: "confirm the employer's authorisation in the autorisationsregister by company name, CVR or authorisation number, and the electrician's own qualification with the school or employer that issued it",
  },
];

const make = (c: Closed): Adapter => ({
  body: c.body,
  name: c.name,
  issuerUrl: c.issuerUrl,
  // These four never fetch — a captcha, a login, or a register that holds companies and not people.
  // Declared here because this factory drops `why` into the closure, which is what made a count
  // testing for that field read all eight adapters as searchable (2026-09-17).
  searchable: false,
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
export const irata = byBody.irata;
export const winda = byBody.winda;
export const cisrs = byBody.cisrs;
export const electricalDk = byBody.electrical_dk;
