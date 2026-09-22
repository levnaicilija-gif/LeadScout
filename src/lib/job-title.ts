import * as cheerio from 'cheerio';

/**
 * A job title, or nothing.
 *
 * Link text is usually the title and sometimes the button — "Bekijk deze vacature", "Read more",
 * "Se stilling". Those said nothing about the work and were being stored as the role, so Hiring
 * now had rows reading "Bekijk deze vacature" where a trade should have been.
 *
 * Careful with the language: "Vacature windturbine monteur in Zeeland" IS a title, and a
 * one-word "Serviceelektriker" is too. Only the phrase that is purely an instruction is junk.
 */
const BUTTON = /^(bekijk( deze)?( vacature| vacatures)?|lees meer|meer( info(rmatie)?)?|solliciteer( direct| nu)?|read more|more( info| details)?|view( job| vacancy| details)?|see( job| more| details)?|apply( now| here)?|details|se stilling(en)?|les mer|søk( på stillingen)?| ?ansøg( nu)?|læs mere|mer info|ansök|hae|lisätiedot|weiterlesen|mehr erfahren|jetzt bewerben|postuler|en savoir plus|vacature|vacatures|vacancy|vacancies|job|jobs|stilling|stillinger|trade role|open position|position)$/i;

/**
 * The same instruction with a verb in front of it — "Browse job offers", "Se alle stillinger".
 *
 * BUTTON is anchored, which is right, but it only holds the bare phrase: "jobs" is refused and
 * "Browse job offers" was not, so it was stored as a role and sat on Hiring now as a vacancy. It
 * reached the job shortlist on 2026-09-22 and would have been suggested to a candidate as a match,
 * which is what this exists to stop. The noun list is BUTTON's own; only the verb is new.
 *
 * Deliberately narrow: the noun has to be the generic word for work, so "Find welders" and
 * "Search engineer" are titles and stay. Measured against all 55 open postings — it matched one.
 */
const NAV = /^(browse|search|find|see|view|explore|all|alle|se|bekijk|zoek|voir|ver)\s+(alle\s+|all\s+|ledige\s+|our\s+|current\s+|open\s+|available\s+)?(job offers?|jobs?|vacature|vacatures|vacancy|vacancies|positions?|openings?|opportunities|stilling|stillinger|stillingar|ledige stillinger|offres?( d'emploi)?|empleos?)$/i;

/** A reference, not a role: a few letters and a number — "REQ-20931", "JR 104522", "ID1924855". */
const REFERENCE = /^[A-Za-z]{1,5}[\s#:._-]*\d{3,}$/;

/** Boilerplate a site puts in front of every title. */
const PREFIX = /^(vacature|vacancy|job|stilling|stelle|offre d'emploi|oferta)\s*[-–—:|]\s*/i;

/** Site furniture a <title> tag carries. */
const SUFFIX = /\s*[-–—|]\s*(careers?|jobs?|vacatures?|werken bij|stillinger|ledige stillinger|karriere|recruitment|apply|home)\b.*$/i;

export function cleanTitle(raw?: string | null): string | null {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (BUTTON.test(t) || NAV.test(t)) return null;
  const stripped = t.replace(PREFIX, '').replace(SUFFIX, '').trim();
  if (!stripped || BUTTON.test(stripped) || NAV.test(stripped)) return null;
  // A title has to say something. One long word is fine — "Serviceelektriker" is a real title.
  if (stripped.length < 4) return null;
  // A number is a reference, not a role: DOF's advert was stored as "1924855", the job id at the end of its address.
  // A requisition code ("REQ-20931", "JR 104522") is the same thing with a prefix.
  if (!/\p{L}{3,}/u.test(stripped) || REFERENCE.test(stripped)) return null;
  return stripped.slice(0, 160);
}

/**
 * Link text is a title with the surrounding page stuck to it.
 *
 * A careers board renders the role, the division, the town, the hours and sometimes the salary
 * as separate elements with no spaces between them, and reading the anchor's text runs them all
 * together: "Elektriker / automatikerHandling SolutionsHareid", "Monteur Technische Dienst
 * Heteren Fulltime/Parttime 4.200 - 5.370", "Industrimekaniker / … Kymar Motion · Bergen".
 *
 * Some of that can be cut safely. The rest means the link text cannot be trusted at all, and the
 * posting page should be asked what it calls itself instead.
 */
const TRAILING_NOISE = /\s*(·|\||–|—)\s*.*$/;                       // "… · Kymar Motion · Bergen"
const SALARY = /\s*\d[\d.,]*\s*[-–]\s*\d[\d.,]*\s*$/;                // "… 4.200 - 5.370"
const MARKERS = /\s*(more details|læs mere|les mer|lees meer|fulltime\/?parttime|fulltime|parttime|heltid|deltid|snarest|lokal ansettelse|vis stilling|apply now)\s*$/i;

/** Strip what is safely strippable, without inventing anything. */
export function stripFurniture(raw: string, companyName?: string | null): string {
  let t = raw.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(SALARY, '').replace(MARKERS, '').trim();
    if (companyName) {
      // The company's own name inside its own vacancy title says nothing.
      const esc = companyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp(`[,\\s]*\\b${esc}\\b[,\\s]*`, 'gi'), ' ').replace(/\s+/g, ' ').trim();
    }
    if (t === before) break;
  }
  return t.replace(/[\s,·|–—-]+$/, '').trim();
}

/**
 * Is this link text too mangled to keep? Then the page itself must be asked.
 * Truncation is the clearest sign: "Servicet..." was cut mid-word by the site.
 */
export function needsPageTitle(raw: string, companyName?: string | null): boolean {
  const t = (raw ?? '').trim();
  if (!t) return true;
  if (!/\p{L}{3,}/u.test(t) || REFERENCE.test(t)) return true;       // a job id or requisition code: ask the page
  if (/\.\.\.|…/.test(t)) return true;                               // the site truncated it
  if (TRAILING_NOISE.test(t)) return true;                           // a separator-joined tail
  if (companyName && new RegExp(companyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(t)) return true;
  if (MARKERS.test(t) || SALARY.test(t)) return true;
  // Two words run together with no space — "VatsVindafjord", "automatikerHandling".
  if (/[a-zæøåäöü][A-ZÆØÅÄÖÜ]/.test(t.replace(/\b[A-Z][a-z]*[A-Z][a-z]*\b/g, ''))) return true;
  return false;
}

/**
 * The title the posting page gives itself. Used only when the link text was a button, so it
 * costs a fetch on the rows that would otherwise be unusable rather than on every row.
 */
export function titleFromPage(html: string): string | null {
  const $ = cheerio.load(html);
  const candidates = [
    $('h1').first().text(),
    $('meta[property="og:title"]').attr('content') ?? '',
    $('[class*="job-title" i], [class*="jobtitle" i], [data-testid*="title" i]').first().text(),
    $('title').first().text(),
  ];
  for (const c of candidates) {
    const clean = cleanTitle(c);
    if (clean) return clean;
  }
  return null;
}
