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
const PHONE_RE = /(?:\+|00)\d[\d\s().-]{7,17}\d/g;

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

/** A switchboard number, normalised only in whitespace — never reformatted into something else. */
export function phoneOn(page: { text: string }) {
  const hit = (page.text.match(PHONE_RE) ?? [])[0];
  return hit ? clean(hit) : null;
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
  people: { name: string; title?: string | null; source: string; company_name: string }[],
  companyName: string,
): FoundContact[] {
  return people
    .filter((p) => isOps(p.title))
    .slice(0, 6)
    .map((p) => ({
      name: p.name,
      title: p.title ?? null,
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
export function organisationLinks(page: { links: string[]; text: string; url: string }, limit = 3): string[] {
  let origin = '';
  try { origin = new URL(page.url).origin; } catch { return []; }

  const scored: { url: string; score: number }[] = [];
  for (const href of page.links) {
    if (!href.startsWith(origin)) continue;                       // never leave the company's site
    const path = href.slice(origin.length).toLowerCase();
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
