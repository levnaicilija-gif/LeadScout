/**
 * Is this company something RFBT could ever place trades with?
 *
 * Item 27's permanent scope rule (owner, 2026-09-26): banks and finance, law firms, universities and
 * academic institutions, government bodies, ministries, regional governments and embassies, and trade
 * associations, federations and clusters are OUT OF SCOPE FOR EVER — not filtered once for a sample. Every
 * euro spent finding a bank's website buys a site for a row that should never become a lead.
 *
 * THIS IS BELT-AND-BRACES AND NOT THE QUEUE, which is the distinction that decides where it belongs. The
 * queue is resolve-domains' own predicate — one of seven sectors AND an ops-relevant Industry Contact at
 * that company — which took Spain from 353 companies to 38 and the whole book to 145. A name filter cannot
 * do that job: measured over the 5,053 no-domain unclassified companies it removes only 541, about 10.7%,
 * and the remainder still holds consultancies, media and monitoring-tech firms (OWC, BOSLAN, Clarion Media,
 * Gastops, Inverto) beside the genuine prospects (Nordex Energy, SPIE Wind Germany, KCI the Engineers).
 * A NAME CANNOT SEPARATE A CONSULTANCY FROM A CONTRACTOR. So this runs on top of the predicate, never
 * instead of it, and its value is catching the obvious institution that slips through a sector tag.
 *
 * "INVESTMENTS" WAS REMOVED ON 2026-09-26, and the reason is the whole argument for keeping this list small.
 * It caught exactly ONE company in the 145-strong queue — Cubico Sustainable Investments, a renewables ASSET
 * OWNER carrying sector offshore_wind and an ops-relevant contact — and caught no genuine bank or fund at
 * all. It had a 0% true-positive rate and a 100% false-positive rate on the only population it will ever
 * run against. The inverse was checked before removing it: no company in that queue carries a finance shape
 * this rule misses (capital, partners, equity, ventures, fund, holdings, asset, invest*, financ*, trust),
 * so nothing needed a compensating pattern. Genuine finance firms are excluded by the QUEUE — wrong sector,
 * no ops-relevant contact — which is what this rule is belt-and-braces for, not a substitute for.
 *
 * THE PATTERNS ARE WRITTEN TO UNDER-MATCH. A missed bank costs one lookup, about EUR 0.023. An over-matched
 * shipyard is silently dropped from the product, and nobody finds out — which is the failure this codebase
 * keeps meeting from the other direction.
 */

/** One category per line, word-boundary anchored, and multilingual where the population is. */
const CATEGORIES: { category: string; re: RegExp }[] = [
  { category: 'bank / finance', re: /\b(bank|banken|banca|banco|landesbank|sparkasse|securities|asset management|capital partners|pensions?|pensionskasse|insurance|forsikring|assurance)\b/i },
  { category: 'law', re: /\b(law firm|lawyers?|advokat\w*|advocaten|advocats?|solicitors?|rechtsanw\w+|avocats?|attorneys?)\b/i },
  { category: 'academic', re: /\b(universit\w+|uniwersytet|hochschule|institute of technology|polytechnic|academy|akademi\w*|school of|college|fachhochschule)\b/i },
  { category: 'government / public', re: /\b(ministry|ministerium|government|regjeringen|kommune|kommun|gemeente|comune|ayuntamiento|municipalit\w+|landskapsregering|county council|authority|myndighet\w*|department of)\b/i },
  { category: 'embassy / consulate', re: /\b(embassy|ambassade|consulate|konsulat)\b/i },
  { category: 'association / body', re: /\b(association|associaci\w+|federation|forbund|f[oö]rening\w*|cluster|chamber of|confederation|society|verband|syndicat)\b/i },
];

/**
 * THE ONE EXCEPTION, and it is deliberately about PLACES rather than industries.
 *
 * "authority" catches Tarragona Port Authority, Salacgriva port authority and Liepaja SEZ authority — and a
 * port is an industrial site that contracts welders, blasters and scaffolders. Port of Kokkola survives the
 * filter only because its name happens to lack the word, which is an accident and not a rule.
 *
 * It must NOT be "any industrial word wins", because that would keep every trade body: the Ukrainian Wind
 * Energy Association, the International Marine Contractors Association and the Humberside Offshore Training
 * Association all read industrial and are all exactly what the owner ruled out. So the exception names a
 * PHYSICAL SITE that employs trades — a port, a dock, a yard — and an association with no site in its name
 * stays excluded.
 */
const SITE = /\b(ports?|harbour|harbor|havn|haven|hafen|puerto|porto|terminal|docks?|dockyard|shipyard|astilleros|werft|verft|yards?)\b/i;

export type NonProspect = { category: string; term: string; keptBySite?: string };

/**
 * Null when the company is in scope. Otherwise the category and the word that matched, so a skipped
 * company can say WHY it was skipped rather than vanishing from a count.
 */
export function nonProspect(name: string | null | undefined): NonProspect | null {
  const n = String(name ?? '');
  if (!n.trim()) return null;                       // nothing to judge on: let the predicate decide
  const hit = CATEGORIES.find(({ re }) => re.test(n));
  if (!hit) return null;
  const site = n.match(SITE);
  if (site) return null;                            // a port authority is a site, not a ministry
  return { category: hit.category, term: (n.match(hit.re) ?? [''])[0] };
}

/** For reporting: why a name that LOOKS institutional was kept anyway. */
export function keptBySite(name: string | null | undefined): string | null {
  const n = String(name ?? '');
  if (!CATEGORIES.some(({ re }) => re.test(n))) return null;
  const site = n.match(SITE);
  return site ? site[0] : null;
}
