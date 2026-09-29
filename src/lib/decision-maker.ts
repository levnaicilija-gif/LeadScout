import { siteReadState, type SiteReadState } from './site-read-state';

/**
 * WHO TO RING AT A COMPANY THAT IS HIRING, in one cell — the rule behind Hiring now's Decision-maker
 * column (2026-09-29).
 *
 * This is a DISPLAY gap, not a discovery gap: every field below is already found, already stored and
 * already shown in the drawer. Measured before building, across the 29 companies with an open posting:
 * 6 have a named person on the company, 4 have one only on the advert, 10 have a general phone or email
 * and only 9 have nothing at all — so 20 of 29 rows were showing none of what is on file.
 *
 * THE ORDER IS THE OWNER'S, 2026-09-29: a named person on the COMPANY, then a named person on the
 * ADVERT, then the general phone, then the general email, then an honest absence. The company person
 * outranks the advert's because they come from an organisation page WITH A TITLE — "René Hansen,
 * Production Manager" — while an advert contact is often a recruiter or carries no title at all
 * ("Stephen Bjorheim", no title). Both are real; one is more useful to a recruiter dialling out.
 *
 * NEVER BLANK WHILE ANYTHING IS KNOWN, and the absence says WHICH absence it is — the rule item 27
 * established for Won work's cell, reusing the same `siteReadState` so the two cannot drift: go and find
 * the site, wait for the crawl, or accept that the site printed nothing are three different actions.
 *
 * Imports only `site-read-state`, which imports nothing at all. A rule two surfaces share cannot sit
 * behind a server-only import: `hiring-contacts.ts` pulls in the Anthropic SDK, and anything reaching a
 * client component through it would take that with it, silently.
 */

export type DecisionMaker =
  | { kind: 'person'; from: 'company' | 'advert'; name: string; title: string | null; detail: string }
  | { kind: 'general'; what: 'switchboard' | 'general email'; value: string; detail: string }
  | { kind: 'none'; state: SiteReadState; text: string };

type Person = { name?: string | null; title?: string | null; phone?: string | null; email?: string | null } | null | undefined;
type Company = {
  domain?: string | null; contacts_checked_at?: string | null;
  switchboard?: string | null; general_email?: string | null;
} | null | undefined;

const text = (v: unknown) => String(v ?? '').trim();

/** What a company printed, in the words the cell shows when nobody is named. */
const ABSENCE: Record<SiteReadState, string> = {
  no_website: 'no website on file',
  not_read: 'their site has not been read yet',
  nothing_printed: 'nothing printed on their site',
};

export function decisionMaker(input: {
  /** People on the COMPANY — read off its organisation or contact pages. */
  people?: Person[] | null;
  /** The contact printed on an open advert, which is a fact about the posting rather than the company. */
  advert?: Person;
  company?: Company;
}): DecisionMaker {
  const onCompany = (input.people ?? []).find((p) => text(p?.name));
  if (onCompany) {
    return {
      kind: 'person', from: 'company', name: text(onCompany.name), title: text(onCompany.title) || null,
      // What a recruiter needs to know before clicking: is there a number, or only an address.
      detail: [text(onCompany.title) || 'title not printed', 'from their site',
        text(onCompany.phone) ? 'phone found' : null, text(onCompany.email) ? 'email found' : null]
        .filter(Boolean).join(' · '),
    };
  }

  const onAdvert = input.advert;
  if (text(onAdvert?.name)) {
    return {
      kind: 'person', from: 'advert', name: text(onAdvert!.name), title: text(onAdvert!.title) || null,
      detail: [text(onAdvert!.title) || 'title not printed', 'from the advert',
        text(onAdvert!.email) ? 'email found' : null].filter(Boolean).join(' · '),
    };
  }

  const co = input.company;
  const switchboard = text(co?.switchboard);
  if (switchboard) return { kind: 'general', what: 'switchboard', value: switchboard, detail: `${switchboard} · from their site` };
  const general = text(co?.general_email);
  if (general) return { kind: 'general', what: 'general email', value: general, detail: `${general} · from their site` };

  const state = siteReadState(co ?? null);
  return { kind: 'none', state, text: ABSENCE[state] };
}
