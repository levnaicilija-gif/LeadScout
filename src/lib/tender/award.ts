/**
 * One TED award record, read into the fields a lead needs — and nothing that is not in it.
 *
 * Every value below is copied from the record or left null, and a null is written out as
 * "not stated in the notice" wherever it is shown. Nothing is filled from somewhere else: when
 * the place of performance is missing the buyer's country is NOT used instead, because a Danish
 * ministry buys grant management in West Africa (628073-2026) and a guess there moves a lead
 * across the geography gate.
 */
import type { TedRecord } from './ted';
import { canonCompany } from '@/lib/company-identity';
import { isEuropean } from '@/lib/geo';

export type AwardValue = { amount: number; currency: string | null; which: 'total value of the notice' | 'value of the results' };
export type AwardDate = { date: string; which: 'award decision' | 'contract concluded' };

export type Award = {
  noticeId: string;
  noticeType: string;
  url: string;
  publishedOn: string;
  buyers: string[];
  buyerCountries: string[];
  winners: string[];
  /** Only when the notice names exactly one winner and one web address, so the two belong together. */
  winnerDomain: string | null;
  value: AwardValue | null;
  awardDate: AwardDate | null;
  title: string;
  titleLang: string;
  description: string | null;
  descriptionLang: string | null;
  /** Every CPV code on the notice, main and additional, procedure and lots. */
  cpv: string[];
  /** The procedure's main classification — what the contract as a whole is for. */
  mainCpv: string[];
  /** ISO alpha-2, European first, from the place of performance only. */
  country: string | null;
  countriesRaw: string[];
  city: string | null;
};

/** TED writes countries in ISO alpha-3. Europe in full, plus where European buyers most often send work. */
const ISO3: Record<string, string> = {
  AUT: 'AT', BEL: 'BE', BGR: 'BG', HRV: 'HR', CYP: 'CY', CZE: 'CZ', DNK: 'DK', EST: 'EE', FIN: 'FI', FRA: 'FR',
  DEU: 'DE', GRC: 'GR', HUN: 'HU', IRL: 'IE', ITA: 'IT', LVA: 'LV', LTU: 'LT', LUX: 'LU', MLT: 'MT', NLD: 'NL',
  POL: 'PL', PRT: 'PT', ROU: 'RO', SVK: 'SK', SVN: 'SI', ESP: 'ES', SWE: 'SE', GBR: 'GB', NOR: 'NO', ISL: 'IS',
  CHE: 'CH', LIE: 'LI', MCO: 'MC', AND: 'AD', SMR: 'SM', VAT: 'VA', ALB: 'AL', BIH: 'BA', MNE: 'ME', MKD: 'MK',
  SRB: 'RS', XKX: 'XK', MDA: 'MD', UKR: 'UA', BLR: 'BY', RUS: 'RU', TUR: 'TR', GEO: 'GE', ARM: 'AM', AZE: 'AZ',
  FRO: 'FO', GRL: 'GL', USA: 'US', CAN: 'CA', CHN: 'CN', IND: 'IN', JPN: 'JP', KOR: 'KR', AUS: 'AU', BRA: 'BR',
  ZAF: 'ZA', EGY: 'EG', MAR: 'MA', TUN: 'TN', NGA: 'NG', GHA: 'GH', KEN: 'KE', ETH: 'ET', SAU: 'SA', ARE: 'AE',
  QAT: 'QA', ISR: 'IL', JOR: 'JO', LBN: 'LB', SGP: 'SG',
};

const first = <T>(v: T | T[] | undefined | null): T | undefined => (Array.isArray(v) ? v[0] : v ?? undefined);
const asList = (v: unknown): string[] => (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => String(x).trim()).filter(Boolean);
const day = (v: unknown) => String(v ?? '').slice(0, 10);

/** { lang: value } → the English entry when there is one, else the notice's own language. */
function pickLang(v: unknown): { lang: string; value: unknown } | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return null;
  const hit = entries.find(([k]) => k === 'eng') ?? entries[0];
  return { lang: hit[0], value: hit[1] };
}

/** Names repeated across lots, once each, in the notice's order. */
function uniqueNames(names: string[]) {
  const seen = new Set<string>();
  return names.filter((n) => {
    const k = canonCompany(n) || n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function amount(v: unknown): number | null {
  const n = Number(first(v as any));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizeAward(r: TedRecord): Award {
  const noticeId = String(r['publication-number']);
  const title = pickLang(r['notice-title']) ?? pickLang(r['title-proc']);
  const description = pickLang(r['description-proc']);
  const winners = pickLang(r['winner-name']);
  const buyers = pickLang(r['buyer-name']);

  const total = amount(r['total-value']);
  const result = amount(r['result-value-notice']);
  const value: AwardValue | null = total
    ? { amount: total, currency: first(asList(r['total-value-cur'])) ?? null, which: 'total value of the notice' }
    : result
      ? { amount: result, currency: first(asList(r['result-value-cur-notice'])) ?? null, which: 'value of the results' }
      : null;

  // The earliest of each: a notice with several lots carries one date per lot.
  const earliest = (v: unknown) => asList(v).map(day).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()[0];
  const decided = earliest(r['winner-decision-date']);
  const concluded = earliest(r['contract-conclusion-date']);
  const awardDate: AwardDate | null = decided
    ? { date: decided, which: 'award decision' }
    : concluded ? { date: concluded, which: 'contract concluded' } : null;

  const countriesRaw = [...new Set([...asList(r['place-of-performance-country-lot']), ...asList(r['place-of-performance-country-proc'])])];
  const iso2 = countriesRaw.map((c) => ISO3[c.toUpperCase()]).filter(Boolean);
  const country = iso2.find((c) => isEuropean(c)) ?? iso2[0] ?? null;

  const winnerNames = uniqueNames(asList(winners?.value));
  const addresses = [...new Set(asList(r['winner-internet-address']))];

  return {
    noticeId,
    noticeType: String(r['notice-type'] ?? ''),
    url: String(r.links?.html?.ENG ?? `https://ted.europa.eu/en/notice/-/detail/${noticeId}`),
    publishedOn: day(r['publication-date']),
    buyers: uniqueNames(asList(buyers?.value)),
    buyerCountries: [...new Set(asList(r['buyer-country']))],
    winners: winnerNames,
    winnerDomain: winnerNames.length === 1 && addresses.length === 1 ? addresses[0] : null,
    value,
    awardDate,
    title: String(title?.value ?? '').trim(),
    titleLang: title?.lang ?? '',
    description: description ? String(description.value).trim() : null,
    descriptionLang: description?.lang ?? null,
    cpv: [...new Set(asList(r['classification-cpv']))],
    mainCpv: [...new Set(asList(r['main-classification-proc']))],
    country,
    countriesRaw,
    city: first(asList(r['place-of-performance-city-lot'])) ?? null,
  };
}

const NOT_STATED = 'not stated in the notice';

export const formatValue = (v: AwardValue | null) =>
  v ? `${v.currency ?? '(currency not stated)'} ${v.amount.toLocaleString('en-GB')} (${v.which})` : null;

/**
 * The stored text of an award: every field on its own line, then the record exactly as the API
 * returned it. Stored as the lead's article, so the drawer's tools read the notice the way they
 * read a news story, and so any field shown anywhere can be traced back to what TED said.
 */
export function awardText(a: Award, record: TedRecord, fetchedAt: string) {
  const { links: _links, ...raw } = record;
  return [
    `Contract award notice — TED ${a.noticeId} (${a.noticeType})`,
    `Published on TED: ${a.publishedOn}`,
    ...(a.buyers.length ? a.buyers.map((b) => `Contracting authority: ${b}`) : [`Contracting authority: ${NOT_STATED}`]),
    `Buyer country: ${a.buyerCountries.join(', ') || NOT_STATED}`,
    ...(a.winners.length ? a.winners.map((w) => `Winning company: ${w}`) : [`Winning company: ${NOT_STATED}`]),
    `Contract value: ${formatValue(a.value) ?? NOT_STATED}`,
    `Award date: ${a.awardDate ? `${a.awardDate.date} (${a.awardDate.which})` : NOT_STATED}`,
    `Place of performance: ${[a.city, a.countriesRaw.join(', ')].filter(Boolean).join(', ') || NOT_STATED}`,
    `Main CPV code: ${a.mainCpv.join(', ') || NOT_STATED}`,
    `All CPV codes: ${a.cpv.join(', ') || NOT_STATED}`,
    `Title (${a.titleLang || 'language not stated'}): ${a.title || NOT_STATED}`,
    `Scope (${a.descriptionLang ?? 'language not stated'}): ${a.description ?? NOT_STATED}`,
    `Source: ${a.url} — read from the TED search API at ${fetchedAt}`,
    '',
    'Record as returned by the API:',
    JSON.stringify(raw),
  ].join('\n');
}

/** The contracting authorities written by awardText, read back. */
export const buyersFromAwardText = (text: string) =>
  [...text.matchAll(/^Contracting authority: (.+)$/gm)].map((m) => m[1].trim()).filter((b) => b !== NOT_STATED);

/** The TED publication date written by awardText, read back. */
export const publishedFromAwardText = (text: string) => text.match(/^Published on TED: (\d{4}-\d{2}-\d{2})$/m)?.[1] ?? null;

/** The award date written by awardText, read back with which kind of date it is. */
export const awardDateFromText = (text: string): AwardDate | null => {
  const m = text.match(/^Award date: (\d{4}-\d{2}-\d{2}) \((award decision|contract concluded)\)$/m);
  return m ? { date: m[1], which: m[2] as AwardDate['which'] } : null;
};
