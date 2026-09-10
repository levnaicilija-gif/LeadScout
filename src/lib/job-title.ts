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

/** Boilerplate a site puts in front of every title. */
const PREFIX = /^(vacature|vacancy|job|stilling|stelle|offre d'emploi|oferta)\s*[-–—:|]\s*/i;

/** Site furniture a <title> tag carries. */
const SUFFIX = /\s*[-–—|]\s*(careers?|jobs?|vacatures?|werken bij|stillinger|ledige stillinger|karriere|recruitment|apply|home)\b.*$/i;

export function cleanTitle(raw?: string | null): string | null {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (BUTTON.test(t)) return null;
  const stripped = t.replace(PREFIX, '').replace(SUFFIX, '').trim();
  if (!stripped || BUTTON.test(stripped)) return null;
  // A title has to say something. One long word is fine — "Serviceelektriker" is a real title.
  if (stripped.length < 4) return null;
  return stripped.slice(0, 160);
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
