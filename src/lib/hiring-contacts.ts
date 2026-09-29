/**
 * Who to call at a company that is hiring — found, never guessed.
 *
 * Same standard as Radar: a name, title, email or phone is only stored when it was read off a
 * page we fetched, and `appearsIn` proves it is on that page rather than something a model
 * produced from the shape of the company name. Anything not found is absent, or shown as a
 * pattern that is labelled a pattern.
 *
 * Five sources, in the order a recruiter would try them:
 *
 *   1. the advert itself       — the contact printed on the posting, with the posting URL
 *   2. the organisation page   — Leadership / Team / Om os, checked once per company; the one
 *                                page that names the HR manager and the production director
 *   3. the company's pages     — switchboard, general email, HR or careers address
 *   4. the attendee list       — people at that company with ops, production, HR or yard titles
 *   5. prepared searches       — when the first four found nobody
 *
 * The fifth is not a contact and is never presented as one. It is a search a recruiter runs.
 */
import { appearsIn } from './ai/claude';
import { cleanCompany, linkedinSearchUrl, googleSearchUrl } from './search-urls';
import { isOps } from './contact-choice';

export type FoundContact = {
  name?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  /** found = read from the page · pattern = built from the company's known pattern · unknown */
  emailStatus: 'found' | 'pattern' | 'unknown';
  sourceUrl: string;
  readAt: string;
  where: 'posting' | 'company page' | 'attendee list' | 'organisation page';
  linkedinSearchUrl?: string;
  googleSearchUrl?: string;
};

export type PreparedSearch = { label: string; url: string };

/* --------------------------------------------------------------- extraction */

// Deliberately conservative. A false positive here becomes a phone number a recruiter dials.
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
// An en dash and a slash continue a number as printed: "+49 (0)3435 – 666 2-0", "+49 (0) 25 93 / 95 93 - 0". Without
// them the read stopped at the area code and stored Kattner Stahlbau and Daldrup & Söhne as "+49 (0)3435" and
// "+49 (0) 25 93" (2026-09-15) — a number a recruiter would dial and reach nobody.
/**
 * The + form only. The `00` alternative used to live here and had NO boundary guard, so it matched a
 * trunk zero found in the MIDDLE of a longer digit run — "Konto 1004692207401" came back as the
 * switchboard "004692207401" (found 2026-09-28 by the check below, not in production). Every 0-leading
 * form, national and 00-international, now goes through PHONE_NAT_RE, which has the lookbehind. The `+`
 * form keeps no lookbehind on purpose: a page stripped of punctuation can print "Tel+49 30 818 700 140",
 * and requiring a boundary there would lose a real number to a missing space.
 */
const PHONE_RE = /\+\d[\d\s().\-–/]{7,24}\d/g;
/**
 * A NATIONAL number with a trunk zero (item 37, 2026-09-28). `PHONE_RE` requires a leading + or 00, so
 * every number printed in domestic format was invisible — which is how Schiffswerft Fischer's imprint
 * could print "Telefon: 04692/20740" and discovery still store nothing. Domestic format is the ORDINARY
 * way a German, Danish or Norwegian company prints its own number, and 460 of the 788 companies with a
 * website on file are NO, NL, DK or DE. The trunk zero must not be picked out of the middle of a longer
 * digit run, hence the lookbehind.
 */
const PHONE_NAT_RE = /(?<![\w+])0\d[\d\s().\-–/]{6,22}\d/g;
/** Fewer digits than this is a fragment — an area code on its own — and a fragment is never offered to dial. */
const PHONE_MIN_DIGITS = 9;
/** E.164 allows 15 at most, so a longer run is an order number, an account number or an ID, not a phone. */
const PHONE_MAX_DIGITS = 15;
/** A number introduced as a fax is never a switchboard: a recruiter would dial it and reach a machine. */
const FAX_LABEL = /(?:fax|telefax|faks|fax\.?nr)\W{0,4}$/i;
/**
 * A PLACEHOLDER IS NOT A PHONE NUMBER (2026-09-29). A real one was stored: Simon Metallverarbeitungs
 * GmbH, a GERMAN company on a .de domain, came back with "+44 1234 567 890" — a UK number, and the
 * classic template digit run — read off a site template nobody had filled in. A recruiter would dial it
 * and reach nothing, which is the same harm as the fax rule above and worse than finding no number.
 *
 * THE THRESHOLDS ARE SET AGAINST OUR OWN REAL NUMBERS, not chosen for tidiness, because a guard that
 * eats a real switchboard is far more expensive than one that misses a fake:
 *   - six identical digits in a row, because Wärtsilä's real "+358 10 709 0000" has FOUR and Equinor's
 *     "+47 51 99 00 00" has pairs throughout;
 *   - seven consecutive ascending or descending digits, because no real number in the book has more
 *     than three, while "1234 567 890" has seven;
 *   - and the ranges regulators RESERVE for fiction, which are real-looking by design.
 */
const SEQUENTIAL_MIN = 7;
const REPEAT_MIN = 6;
/** Ofcom's drama ranges and the North American 555-01xx block: reserved so they can never reach anyone. */
const RESERVED_RANGES: { re: RegExp; why: string }[] = [
  { re: /^(?:44|0)?1632960/, why: "Ofcom drama range 01632 960xxx" },
  { re: /^(?:44|0)?2079460/, why: "Ofcom drama range 020 7946 0xxx" },
  { re: /^(?:44|0)?7700900/, why: "Ofcom drama mobile range 07700 900xxx" },
  { re: /^(?:44|0)?(?:113|114|115|116|117|118|121|131|141|151|161|191)4960/, why: "Ofcom drama range 0xxx 496 0xxx" },
  { re: /^(?:44|0)?8081570/, why: "Ofcom drama freephone range 08081 570xxx" },
  { re: /^(?:44|0)?3069990/, why: "Ofcom drama range 03069 990xxx" },
  { re: /55501\d\d$/, why: "North American fictional range 555-01xx" },
];

/** Digits only, then: is this a number nobody can be reached on? */
function isPlaceholder(number: string): string | null {
  const d = number.replace(/\D/g, '');
  const repeat = new RegExp(`(\\d)\\1{${REPEAT_MIN - 1},}`).exec(d);
  if (repeat) return `${repeat[0].length} identical digits in a row`;
  let run = 1;
  for (let i = 1; i < d.length; i++) {
    const step = Number(d[i]) - Number(d[i - 1]);
    run = (step === 1 || step === -1) && (i < 2 || Number(d[i - 1]) - Number(d[i - 2]) === step) ? run + 1 : 2;
    if (run >= SEQUENTIAL_MIN) return `${run} consecutive digits`;
  }
  for (const r of RESERVED_RANGES) if (r.re.test(d)) return r.why;
  return null;
}

/** A number a page LABELS as its phone beats an unlabelled digit run on the same page. */
const TEL_LABEL = /(?:tel|telefon|telefone|telephone|téléphone|phone|tlf|tlf\.|mobil|mobile|sentralbord|switchboard|kontakt)\w*\W{0,4}$/i;

/** Addresses that are a company's front door rather than a person's. */
const GENERAL = /^(info|post|mail|office|kontakt|contact|firmapost|enquiries|hello|admin|sales)@/i;
const HR = /^(hr|jobb?|jobs|career|careers|recruit(ment)?|personal|personnel|rekruttering|vacature|bewerbung|praca|kariera|cv)@/i;
/** Never offer these as somewhere to send an approach. */
const NOISE = /^(noreply|no-reply|donotreply|postmaster|abuse|webmaster|privacy|dpo|gdpr|legal|press|media|invoice|faktura|accounts?)@|\.(png|jpe?g|gif|svg|webp)$|sentry|wixpress|example\.com/i;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Emails on a page, split by what they are for. Only addresses on the company's own domain are
 * kept: a careers page routinely carries the addresses of its job-board supplier, its agency and
 * its web designer, and any of those would be a stranger receiving a pitch about their client.
 */
export function emailsOn(page: { text: string; url: string }, domain?: string | null) {
  const host = (domain ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  const found = [...new Set((page.text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))]
    .filter((e) => !NOISE.test(e))
    .filter((e) => !host || e.endsWith(`@${host}`) || e.endsWith(`.${host}`));
  return {
    hr: found.find((e) => HR.test(e)) ?? null,
    general: found.find((e) => GENERAL.test(e)) ?? null,
    all: found,
  };
}

/**
 * A switchboard number, normalised only in whitespace — never reformatted into something else.
 *
 * Both formats are read (item 37): international, and national with a trunk zero. Two rules decide which
 * of several numbers on a page is offered, and both exist to stop a recruiter dialling the wrong thing:
 * a number introduced as a FAX is dropped outright, and a number a page LABELS as its phone beats an
 * unlabelled digit run. Otherwise the first match wins, as before. A run of more than 15 digits is not a
 * phone number at all — E.164 allows 15 — so an order or account number can no longer be stored as one.
 */
export function phoneOn(page: { text: string }) {
  const text = page.text ?? '';
  const seen: { number: string; at: number; labelled: boolean }[] = [];
  for (const re of [PHONE_RE, PHONE_NAT_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const number = clean(m[0]);
      const digits = number.replace(/\D/g, '').length;
      if (digits < PHONE_MIN_DIGITS || digits > PHONE_MAX_DIGITS) continue;
      // The words immediately before it decide what it IS. "Telefax: 04692/20742" is not a switchboard.
      const before = text.slice(Math.max(0, m.index - 24), m.index);
      if (FAX_LABEL.test(before)) continue;
      // A template's unfilled example number is not somewhere a recruiter can ring.
      if (isPlaceholder(number)) continue;
      if (seen.some((s) => s.number === number)) continue;
      seen.push({ number, at: m.index, labelled: TEL_LABEL.test(before) });
    }
  }
  if (!seen.length) return null;
  const inOrder = seen.sort((a, b) => a.at - b.at);
  return (inOrder.find((s) => s.labelled) ?? inOrder[0]).number;
}

/**
 * A contact printed on an advert.
 *
 * Only accepted when the name and, where given, the email and phone are all literally on the
 * page. The model reads; `appearsIn` decides whether what it read is really there.
 */
export function contactFromPosting(
  page: { text: string; url: string; fetchedAt: string },
  read: { name?: string | null; title?: string | null; email?: string | null; phone?: string | null } | null,
  domain?: string | null,
): FoundContact | null {
  if (!read?.name) return null;
  const name = clean(read.name);
  if (name.split(' ').length < 2) return null;                    // "HR" is not a person
  if (!appearsIn(page.text, name)) return null;

  const email = read.email && appearsIn(page.text, read.email) && !NOISE.test(read.email) ? read.email.toLowerCase() : null;
  const phone = read.phone && appearsIn(page.text, read.phone) ? clean(read.phone) : null;
  const title = read.title && appearsIn(page.text, read.title) ? clean(read.title) : null;

  return {
    name, title, email, phone,
    emailStatus: email ? 'found' : 'unknown',
    sourceUrl: page.url,
    readAt: page.fetchedAt,
    where: 'posting',
  };
}

/**
 * An address built from a company's known email pattern.
 *
 * Returned marked `pattern`, always. This is the one place a contact detail is produced rather
 * than read, and the only honest way to carry it is to say so everywhere it appears — the UI
 * shows "pattern", and outreach refuses to treat it as a confirmed address.
 */
export function patternEmail(pattern: string | null | undefined, name: string): { email: string; emailStatus: 'pattern' } | null {
  if (!pattern || !name) return null;
  const parts = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const first = parts[0];
  const last = parts[parts.length - 1];
  const built = pattern
    .replace(/\{?first(name)?\}?/gi, first)
    .replace(/\{?last(name)?\}?/gi, last)
    .replace(/\{?f\}?(?=[.\-_])/gi, first[0])
    .replace(/\{?l\}?(?=@)/gi, last[0]);
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(built) ? { email: built.toLowerCase(), emailStatus: 'pattern' } : null;
}

/* ----------------------------------------------------------- attendee list */

/** People already on file at this company whose title means they decide who turns up. */
export function fromAttendeeList(
  people: { name: string; title?: string | null; source: string; company_name: string; match?: 'name' | 'group' }[],
  companyName: string,
): FoundContact[] {
  return people
    .filter((p) => isOps(p.title))
    .slice(0, 6)
    .map((p) => ({
      name: p.name,
      // A person matched through the group (src/lib/attendee-match.ts) says which part of it the list put them at.
      title: p.match === 'group' ? `${p.title} · ${p.company_name}` : p.title ?? null,
      email: null,
      phone: null,
      emailStatus: 'unknown' as const,
      // The list is the evidence for the name and title, and for nothing else.
      sourceUrl: p.source,
      readAt: '',
      where: 'attendee list' as const,
      linkedinSearchUrl: linkedinSearchUrl(p.name, companyName),
      googleSearchUrl: googleSearchUrl(p.name, companyName),
    }));
}

/* -------------------------------------------------------- prepared searches */

const ROLES = [
  ['production manager', 'runs the shop floor'],
  ['HR manager', 'holds the requisition'],
  ['yard manager', 'runs the site'],
  ['resourcing', 'books the people'],
];

/**
 * When nothing was found, what a recruiter should search for.
 *
 * These are searches, not contacts. They are rendered as links to run, never as a person, and
 * nothing here is ever written to the contacts table.
 */
export function preparedSearches(companyName: string): PreparedSearch[] {
  const co = cleanCompany(companyName);
  return ROLES.map(([role, why]) => ({
    label: `${role} — ${why}`,
    url: `https://www.google.com/search?q=${encodeURIComponent(`"${co}" "${role}" site:linkedin.com/in`)}`,
  }));
}

/* --------------------------------------------------------------- assembling */

export type ContactSheet = {
  contacts: FoundContact[];
  switchboard?: { value: string; sourceUrl: string } | null;
  generalEmail?: { value: string; sourceUrl: string } | null;
  hrEmail?: { value: string; sourceUrl: string } | null;
  searches: PreparedSearch[];
  /** True when nothing above a prepared search was found — the honest empty state. */
  nobodyFound: boolean;
  primary?: FoundContact | null;
};

export function buildSheet(input: {
  companyName: string;
  postingContacts: FoundContact[];
  orgContacts?: FoundContact[];
  attendees: FoundContact[];
  switchboard?: string | null; switchboardSource?: string | null;
  generalEmail?: string | null; generalEmailSource?: string | null;
  hrEmail?: string | null; hrEmailSource?: string | null;
}): ContactSheet {
  // Order is the recommendation. A person printed on the advert is answering about this job;
  // an HR or production lead off the organisation page decides whether a crew is booked at all;
  // an attendee-list name is someone we know exists. The switchboard is below all of them, and
  // is still always shown.
  const contacts = [...input.postingContacts, ...(input.orgContacts ?? []), ...input.attendees];
  return {
    contacts,
    // The front door is always shown when it is known: a switchboard that reaches a real yard
    // beats a named person nobody can find an address for.
    switchboard: input.switchboard && input.switchboardSource ? { value: input.switchboard, sourceUrl: input.switchboardSource } : null,
    generalEmail: input.generalEmail && input.generalEmailSource ? { value: input.generalEmail, sourceUrl: input.generalEmailSource } : null,
    hrEmail: input.hrEmail && input.hrEmailSource ? { value: input.hrEmail, sourceUrl: input.hrEmailSource } : null,
    searches: preparedSearches(input.companyName),
    nobodyFound: contacts.length === 0 && !input.generalEmail && !input.hrEmail && !input.switchboard,
    /** Who to try first, and why — null when nobody was found at all. */
    primary: contacts[0] ?? null,
  };
}

/* ------------------------------------------------- the organisation page */

/**
 * The "Organization" / "Leadership" / "Team" / "Om os" page.
 *
 * A fifth source, checked once per company rather than once per posting, because it is a fact
 * about the company and not about the advert. It is usually in the main navigation, separately
 * from Contact and from Jobs, and it is the one page that routinely names the HR manager and
 * the production or operations director — the two people who actually decide whether a trade
 * crew is booked.
 *
 * Words in the languages these companies publish in. "Om os", "Ledelse", "Über uns": a Danish
 * yard does not have an About page.
 */
const ORG_WORDS = [
  'organisation', 'organization', 'leadership', 'management', 'team', 'our people', 'people',
  'about us', 'about', 'who we are', 'contact us',
  'om os', 'om oss', 'ledelse', 'ledelsen', 'medarbejdere', 'ansatte', 'kontakt os',
  'über uns', 'unternehmen', 'geschäftsführung', 'ansprechpartner', 'mitarbeiter',
  'over ons', 'ons team', 'directie', 'medewerkers',
  'o nas', 'zarząd', 'kierownictwo',
  'equipo', 'nuestro equipo', 'direccion', 'chi siamo', 'direzione',
];

/** Links on a site that look like an organisation or leadership page, best first. */
export function organisationLinks(page: { links: string[]; text: string; url: string; finalUrl?: string | null }, limit = 3): string[] {
  const scored: { url: string; score: number }[] = [];
  for (const href of page.links) {
    // THE SAME apex/www FIX as contactLinks, and this one has been costing yield since item 13: a home
    // page fetched at the apex that links its own pages as www had EVERY candidate dropped here, which is
    // the likeliest reason only 2 of 25 home pages were found to link an organisation page on 2026-09-15.
    // That measurement is not re-stated as a finding — it simply cannot be trusted as a ceiling.
    if (!onSameSite(href, page.url, page.finalUrl)) continue;      // never leave the company's site
    let path = '';
    try { const u = new URL(href); path = `${u.pathname}${u.search}`.toLowerCase(); } catch { continue; }
    if (!path || path === '/' || /\.(pdf|jpe?g|png|svg|zip|docx?)$/i.test(path)) continue;
    // A careers page is already read elsewhere, and a news index is not an organisation page.
    if (/\b(job|jobs|karriere|career|vacatur|vacancies|ledige|news|nyhed|press|blog|produkt|product|shop)\b/.test(path)) continue;

    const hit = ORG_WORDS.findIndex((w) => path.includes(w.replace(/\s+/g, '-')) || path.includes(w.replace(/\s+/g, '')));
    if (hit === -1) continue;
    // Earlier in the list is a better word: "leadership" beats "about".
    scored.push({ url: href, score: 100 - hit });
  }
  return [...new Map(scored.sort((a, b) => b.score - a.score).map((s) => [s.url, s])).values()]
    .slice(0, limit).map((s) => s.url);
}

/**
 * THE SITE'S OWN CONTACT PAGE, FOUND BY FOLLOWING ITS LINKS RATHER THAN GUESSING AN ENGLISH PATH
 * (item 37, 2026-09-28). Found by a worked example: Schiffswerft Fischer GmbH's website was written in
 * by hand, discovery ran on that company alone and returned NOTHING — no switchboard, no email, EUR 0.00,
 * never reaching a model — and the site is not silent. For a company with only a domain, step 1 tried
 * exactly ONE url, `https://<domain>/contact`, which is a 404 there; so is `/kontakt`. The page that
 * exists is `/impressum` (a German imprint is legally mandatory and always carries a phone), the home
 * page LINKS to it, and the contact details are also on the home page itself at `#Contact`/`#Kontakt`.
 *
 * MATCHED ON THE LAST PATH SEGMENT, EXACTLY, NOT AS A SUBSTRING. `scripts/resolve-wonwork-domains.ts`
 * has a substring version for its address CHECK, where a wrong page is harmless — it simply fails to
 * find the postcode. Here a wrong page is a phone number attributed to the wrong company, so the rule is
 * strict: "contact-lenses" contains "contact" and must never be followed, and exact-segment matching is
 * what stops it. Compound forms are listed explicitly instead of loosening the match.
 *
 * SAME-PAGE FRAGMENTS ARE SKIPPED, because `#Kontakt` is the home page, which is read directly — that is
 * the other half of this fix and it costs nothing, since the home page is already fetched for
 * `organisationLinks`.
 *
 * THE VOCABULARY IS MEASURED AGAINST THE POPULATIONS WE ACTUALLY HAVE, not guessed: of 788 companies with
 * a website on file, NO 221, NL 213, DK 73, DE 26, GB 19, BE 17, ES 10, SE 4, FR 4, IE 3. So Norwegian,
 * Dutch, Danish and German carry the weight and are covered first; Italian and Polish are one row each
 * and are included because a term costs nothing, while Greek (2 rows) is deliberately absent rather than
 * transliterated on a guess.
 */
const CONTACT_SEGMENTS: string[] = [
  // best first: a contact page beats an imprint, which beats an "about" page
  'contact', 'contacts', 'contact-us', 'contactus', 'contact-me',
  'kontakt', 'kontakt-oss', 'kontakta-oss', 'kontakt-os', 'kontaktformular',
  'contacto', 'contactanos', 'contactar', 'contatti', 'nous-contacter', 'contactez-nous',
  'impressum', 'imprint', 'legal-notice', 'mentions-legales', 'aviso-legal', 'informacion-legal',
  'om-oss', 'om-os', 'over-ons', 'o-nas', 'chi-siamo', 'about-us', 'about', 'empresa', 'firma',
];
/** The same words as a link's visible TEXT, normalised. A site may link /kontakt as "Kontakt oss". */
const CONTACT_TEXT: string[] = [
  'contact', 'contact us', 'contacts', 'kontakt', 'kontakt oss', 'kontakta oss', 'kontakt os',
  'contacto', 'contáctanos', 'contactanos', 'contatti', 'nous contacter', 'contactez-nous',
  'impressum', 'imprint', 'legal notice', 'mentions légales', 'mentions legales', 'aviso legal',
  'om oss', 'om os', 'over ons', 'o nas', 'chi siamo', 'about', 'about us', 'empresa',
];

/**
 * APEX AND www ARE THE SAME SITE for the purpose of following a link, and treating them as different
 * origins silently drops every link on the page (item 37, 2026-09-28). Found on the live site rather than
 * in a fixture: `fetchPage('https://schiffswerft-fischer.de')` redirects, so `finalUrl` is
 * `https://www.schiffswerft-fischer.de/` and all 27 of its links are `www.` — while the origin was taken
 * from the REQUESTED url. Every candidate was thrown away and the step reported "no contact links", which
 * is indistinguishable from a site that links none.
 *
 * This is the same trap `scripts/feed-discovery.ts` records for `articleLinks`, where a feed could parse
 * perfectly and yield NOTHING because the index was read at the other host form. There it is solved by
 * trying both host forms; here the question is only "is this link on the same company's site", and for
 * that apex and www are the same answer.
 */
const bareHostOf = (u: string) => { try { return new URL(u).host.replace(/^www\./i, '').toLowerCase(); } catch { return ''; } };
const onSameSite = (href: string, pageUrl: string, finalUrl?: string | null) => {
  const h = bareHostOf(href);
  if (!h) return false;
  return h === bareHostOf(pageUrl) || (!!finalUrl && h === bareHostOf(finalUrl));
};

/** The last path segment, lowercased, separators normalised, extension and trailing slash removed. */
function lastSegment(path: string): string {
  const clean = path.split('?')[0].split('#')[0].replace(/\/+$/, '');
  const seg = clean.split('/').filter(Boolean).pop() ?? '';
  return seg.toLowerCase().replace(/_/g, '-').replace(/\.(html?|php|aspx?)$/, '');
}

/**
 * The company's own contact / imprint pages, best first, never leaving its origin and never the home
 * page itself. `texts` is the visible text of each link, index-aligned with `links` where the caller has
 * it; a caller without it passes nothing and only the path is matched.
 */
export function contactLinks(page: { links: string[]; url: string; linkTexts?: string[]; finalUrl?: string | null }, limit = 2): string[] {
  const scored: { url: string; score: number }[] = [];
  page.links.forEach((href, i) => {
    if (!onSameSite(href, page.url, page.finalUrl)) return;          // never leave the company's site
    let path = '';
    try { const u = new URL(href); path = `${u.pathname}${u.search}${u.hash}`; } catch { return; }
    // A pure fragment or the bare root IS the home page, which is read directly rather than re-fetched.
    if (!path || path === '/' || path.startsWith('#') || /^\/#/.test(path)) return;
    if (/\.(pdf|jpe?g|png|svg|zip|docx?|xlsx?)$/i.test(path)) return;
    const seg = lastSegment(path);
    const byPath = CONTACT_SEGMENTS.indexOf(seg);
    const text = (page.linkTexts?.[i] ?? '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[:•|]+$/, '').trim();
    const byText = text ? CONTACT_TEXT.indexOf(text) : -1;
    if (byPath === -1 && byText === -1) return;
    // Earlier in the list is a better page: a contact page outranks an imprint, which outranks "about".
    const rank = byPath === -1 ? byText + CONTACT_SEGMENTS.length : byPath;
    scored.push({ url: href, score: 1000 - rank });
  });
  return [...new Map(scored.sort((a, b) => b.score - a.score).map((s) => [s.url, s])).values()]
    .slice(0, limit).map((s) => s.url);
}

/** Titles worth having as the primary contact for a trade-hiring approach, best first. */
const PRIMARY_TITLE: { re: RegExp; rank: number; what: string }[] = [
  { re: /\b(hr|human resources|personal|personale|personeel)\b.*\b(manager|chef|leder|direktor|director|lead|head)\b|\b(manager|chef|leder|head)\b.*\b(hr|human resources|personal)\b/i, rank: 1, what: 'HR manager' },
  { re: /\b(production|produktion|produksjon|productie|operations|drift)\b.*\b(director|direktør|manager|chef|leder|head)\b|\b(director|manager|head)\b.*\b(production|operations|drift)\b/i, rank: 2, what: 'production or operations director' },
  { re: /\b(yard|verft|værft|werft)\b.*\b(manager|director|chef|leder)\b/i, rank: 3, what: 'yard manager' },
  { re: /\b(resourc|recruit|talent|crewing|manpower|bemanding)\w*\b/i, rank: 4, what: 'resourcing' },
];

export const primaryRank = (title?: string | null) => {
  if (!title) return null;
  const hit = PRIMARY_TITLE.find((t) => t.re.test(title));
  return hit ? { rank: hit.rank, what: hit.what } : null;
};

/**
 * People read off an organisation page.
 *
 * Every name must be literally on the page, and a name is only kept when it sits near a title
 * that means something for hiring — an organisation page lists the whole board, and a chief
 * financial officer is not who books welders.
 */
export function contactsFromOrgPage(
  page: { text: string; url: string; fetchedAt: string },
  read: { name?: string | null; title?: string | null; email?: string | null; phone?: string | null }[],
  companyName: string,
  domain?: string | null,
): FoundContact[] {
  const host = (domain ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  const out: (FoundContact & { rank: number })[] = [];

  for (const r of read ?? []) {
    if (!r?.name) continue;
    const name = clean(r.name);
    if (name.split(' ').length < 2) continue;
    if (!appearsIn(page.text, name)) continue;

    const title = r.title && appearsIn(page.text, r.title) ? clean(r.title) : null;
    const ranked = primaryRank(title);
    if (!ranked) continue;                                        // on the page, but not our person

    const email = r.email
      && appearsIn(page.text, r.email)
      && !NOISE.test(r.email)
      && (!host || r.email.toLowerCase().endsWith(`@${host}`) || r.email.toLowerCase().endsWith(`.${host}`))
      ? r.email.toLowerCase() : null;
    const phone = r.phone && appearsIn(page.text, r.phone) ? clean(r.phone) : null;

    out.push({
      name, title, email, phone,
      emailStatus: email ? 'found' : 'unknown',
      sourceUrl: page.url,
      readAt: page.fetchedAt,
      where: 'organisation page',
      linkedinSearchUrl: linkedinSearchUrl(name, companyName),
      googleSearchUrl: googleSearchUrl(name, companyName),
      rank: ranked.rank,
    });
  }

  // HR manager first, then production or operations — the two who decide a trade booking.
  return out.sort((a, b) => a.rank - b.rank).map(({ rank, ...c }) => c);
}
