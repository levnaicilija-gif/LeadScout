/**
 * Queue item 14: a news story becomes a visible lead only when all three hold —
 *   1. a real business trigger, not an early-stage or years-out milestone;
 *   2. a named representative of the company is quoted;
 *   3. that representative is someone to write to (quoted-contacts.ts).
 * Anything else is kept as a rejected or low-confidence record with its reasons, never dropped.
 *
 * Pure: no database, no model. Every rule reads the article's own words and records the sentence
 * it acted on, so a verdict can be argued with. Owner's decisions, 2026-09-13:
 *   · FEED, a letter of intent pending an investment decision, concept studies and a developer
 *     winning a site are NOT triggers;
 *   · work starting more than 12 months after the article is not yet a lead — held as low
 *     confidence to 18 months, rejected beyond;
 *   · a representative of another company counts only if that company is a target account: an
 *     active lead (pursue, contacted, replied, call, trial, framework) or pursued hiring.
 * Award notices from TED are never judged here: they quote nobody by design.
 */
import type { ContactChoice, Quoted, EmployerContext } from './quoted-contacts';
import { chooseQuoted, companyAliases } from './quoted-contacts';
import { appearsIn } from './ai/claude';

export const RULES_VERSION = '14.1';
export const LOW_CONFIDENCE_MONTHS = 12;
export const REJECT_MONTHS = 18;

export type RuleId =
  | 'excluded_trigger' | 'early_stage' | 'developer_or_auction' | 'years_out' | 'years_out_borderline'
  | 'no_rep' | 'rep_excluded_role' | 'rep_other_company' | 'rep_unverified';
export type Rule = { id: RuleId; why: string; evidence?: string };
export type Verdict = { verdict: 'lead' | 'low_confidence' | 'rejected'; rules: Rule[]; reason: string; contacts: ContactChoice; rulesVersion: string };

const HARD: RuleId[] = ['excluded_trigger', 'early_stage', 'developer_or_auction', 'years_out', 'no_rep', 'rep_excluded_role', 'rep_other_company'];

export function sentences(text: string): string[] {
  return String(text ?? '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 20);
}

/**
 * A sentence someone wrote, as opposed to site chrome. Stored pages open with navigation glued
 * together — "CompanyAbout UsNews & InsightsInvestors…The McDermott Difference" — which names the
 * company and says nothing; the first version of this filter read those as the story and let a
 * letter of intent and a consultancy framework through. Prose has ordinary lower-case words.
 */
const isProse = (s: string) => (s.match(/\b[a-z]{2,}\b/g) ?? []).length >= 6;

/** The title and the opening prose that names the company — where a story says what happened. */
export function lede(title: string, text: string, aliases: string[]): string {
  const canon = (s: string) => ` ${s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const prose = sentences(text).filter(isProse);
  const naming = prose.filter((s) => aliases.some((a) => canon(s).includes(` ${a} `))).slice(0, 6);
  return [title, ...naming, ...prose.slice(0, 4)].join('\n');
}

const firstMatch = (text: string, re: RegExp) => sentences(text).find((s) => re.test(s)) ?? null;

const CONSENTING = /\b(scoping (report|request|opinion)|environmental impact assessment|EIA\b|habitats regulations|consent application|development consent|planning (application|permission|consent)|licen[cs]e application|permit application|pre-application|public consultation)/i;
const AWARDED = /\b(awarded|awards|wins|won|secures?|selected|signs?|signed|order)\b/i;
const EARLY = /\b(pre-?FEED|FEED\b|front[- ]end engineering|concept (study|select|design|development)|(feasibility|safety|cost|design|options?|electrical|infrastructure|engineering|technical) (and \w+ )?stud(y|ies)|letter of intent|LOI\b|memorandum of understanding|MoU\b|development phase|(awarded|selected|appointed)[^.]{0,40}\bdelivery partner\b|project management consultancy|(ahead of|subject to|pending|towards?|to support) (a |the )?(final investment decision|FID)|(targeted|expected|planned|anticipated) (final investment decision|FID)|(final investment decision|FID) (is )?(planned|expected|targeted|pending|anticipated))/i;

/**
 * An award for engineering or design services alone. The owner ruled concept studies are not a
 * trigger; an engineering-only award is the same thing at a later stage — Worley engineering
 * D-CRBN's plant, designing BCEI's energy centres — work done in offices, before anyone is hired
 * to build. It stands only when the opening lines name no build contract.
 */
const ENGINEERING_ONLY = /\bengineering(,| and| &) (detailed )?design (and procurement support )?services\b|\bengineering services( contracts?)?\b/i;
const BUILD_CONTRACT = /\b(EPC\w*|construction (contract|services|work)|installation (contract|services|work)|fabrication|maintenance (contract|agreement)|service agreement|subsea contract|frame agreement|drilling)\b/i;
const DEVELOPER = /\b(auction|winning bid|seabed (lease|rights)|(development|concession) rights|won the rights?)\b|\b(awarded|wins?|won|secures?)\b.{0,80}\b(wind|solar)\b.{0,30}\b(projects?|farms?|sites?|zones?)\b.{0,60}\b(tender|auction|lease)\b/i;

/** Work starting, as opposed to operating, completing or being delivered. */
const START = /(construction|installation|offshore works|site works|fabrication|mobili[sz]ation|deployment)\b.{0,60}\b(start|begin|commence|planned|scheduled|due)|\b(start|begin|commence)\w*\b.{0,40}\b(construction|installation|works?|fabrication|mobili[sz]ation|deployment)/i;
const ALREADY = /\b(has|have) (already )?(started|begun|commenced)\b|\bunder ?way\b|\bis (now )?in progress\b/i;
const MONTH: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** The earliest moment a sentence's timeline could mean, as a Date. Anything unreadable is null. */
function earliestIn(s: string): Date | null {
  const dates: Date[] = [];
  for (const m of s.matchAll(/\b(early|mid|late)[- ](20\d)0s\b/gi)) dates.push(new Date(Date.UTC(Number(`${m[2]}0`) + ({ early: 0, mid: 4, late: 7 } as any)[m[1].toLowerCase()], 0, 1)));
  for (const m of s.matchAll(/\bQ([1-4])\s*(20\d\d)\b/gi)) dates.push(new Date(Date.UTC(Number(m[2]), (Number(m[1]) - 1) * 3, 1)));
  for (const m of s.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(20\d\d)\b/gi)) dates.push(new Date(Date.UTC(Number(m[2]), MONTH[m[1].toLowerCase()], 1)));
  for (const m of s.matchAll(/\b(20\d\d)\b(?!s)/g)) dates.push(new Date(Date.UTC(Number(m[1]), 0, 1)));
  return dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
}

export function timeline(text: string, articleDate: Date): { months: number; sentence: string } | null {
  let best: { months: number; sentence: string } | null = null;
  for (const s of sentences(text)) {
    if (!START.test(s) || ALREADY.test(s)) continue;
    const at = earliestIn(s);
    if (!at) continue;
    const months = (at.getUTCFullYear() - articleDate.getUTCFullYear()) * 12 + (at.getUTCMonth() - articleDate.getUTCMonth());
    if (!best || months < best.months) best = { months, sentence: s };
  }
  return best;
}

export type NewsInput = {
  title: string;
  text: string;
  url: string;
  companyName: string;
  companyDomain?: string | null;
  project: { name?: string | null; location?: string | null };
  people: Quoted[];
  articleDate: Date;
  targets: Set<string>;
  /** From the extraction, when it said so: a developer or owner, not the contractor. */
  companyRole?: string | null;
};

export function evaluateNews(i: NewsInput): Verdict {
  const aliases = companyAliases(i.companyName, i.companyDomain);
  const head = lede(i.title, i.text, aliases);
  const rules: Rule[] = [];

  const consent = firstMatch(head, CONSENTING);
  if (consent && !AWARDED.test(i.title)) rules.push({ id: 'excluded_trigger', why: 'consenting, planning or an impact assessment — a regulatory step, not work won', evidence: consent });
  const early = firstMatch(head, EARLY);
  if (early) rules.push({ id: 'early_stage', why: 'FEED, a study, a letter of intent or work pending an investment decision — not yet work that needs trades', evidence: early });
  const engineeringOnly = firstMatch(head, ENGINEERING_ONLY);
  if (engineeringOnly && !early && !BUILD_CONTRACT.test(head)) rules.push({ id: 'early_stage', why: 'engineering or design services only — no construction, installation or maintenance contract named', evidence: engineeringOnly });
  const developer = firstMatch(head, DEVELOPER);
  if (developer || i.companyRole === 'developer_or_owner') rules.push({ id: 'developer_or_auction', why: 'a developer or owner winning a site or an auction, not a contractor winning work', evidence: developer ?? `extraction: company_role = ${i.companyRole}` });

  const t = timeline(i.text, i.articleDate);
  if (t && t.months > REJECT_MONTHS) rules.push({ id: 'years_out', why: `work starts about ${t.months} months after the article — more than ${REJECT_MONTHS}`, evidence: t.sentence });
  else if (t && t.months > LOW_CONFIDENCE_MONTHS) rules.push({ id: 'years_out_borderline', why: `work starts about ${t.months} months after the article — between ${LOW_CONFIDENCE_MONTHS} and ${REJECT_MONTHS}`, evidence: t.sentence });

  const ctx: EmployerContext & { project: NewsInput['project'] } = { text: i.text, aliases, sourceUrl: i.url, companyName: i.companyName, companyDomain: i.companyDomain, targets: i.targets, project: i.project };
  const contacts = chooseQuoted(i.people.filter((p) => appearsIn(i.text, p.name)), ctx);
  if (!contacts.primary) {
    if (contacts.excluded.length) {
      for (const x of contacts.excluded) rules.push({ id: x.rule, why: x.why });
    } else if (contacts.unverified.length) {
      rules.push({ id: 'rep_unverified', why: contacts.unverified.map((u) => u.why).join('; ') });
    } else {
      rules.push({ id: 'no_rep', why: 'nobody from the company is quoted by name with a title' });
    }
  }

  const hard = rules.filter((r) => HARD.includes(r.id));
  const verdict: Verdict['verdict'] = hard.length ? 'rejected' : rules.length ? 'low_confidence' : 'lead';
  const reason = verdict === 'lead' ? `trigger and contact both stand: ${contacts.why}` : (hard[0] ?? rules[0]).why;
  return { verdict, rules, reason, contacts, rulesVersion: RULES_VERSION };
}
