/**
 * Is a website the winning entity's own, or its group's?
 *
 * A tender is won by a specific legal entity — "COLAS FRANCE", "COLAS France ETABLISSEMENT COTE BASQUE", "Aellia
 * Belgium NV" — and a web search for it often lands on the group: colas.com, aellia.com. A switchboard read there
 * reaches the group's front door, not the operation that won the work, which can be worse than no contact. This never
 * decides the site is wrong; it says when the site looks like the group's, and why, so the drawer can say so.
 *
 * Pure rules, no network:
 *   branch — the winner's name marks a branch, agency or establishment of a larger company ("ETABLISSEMENT", "agence",
 *            "Niederlassung", "branch", "sucursal"…): any site on the brand is the parent's;
 *   country — the winner's name carries a country ("FRANCE", "Belgium", "Norge"…) and the site is the brand on a generic
 *            domain (.com, .net, .group…) or another country's: that is the international group's site. The same brand
 *            on the winner's own country domain (ccecc.ro for "… ROMANIA SRL") is the local entity's;
 *   shared — the same domain is already on file for a company with a different name.
 */
export type SiteScope = { scope: 'own' | 'group'; reason: string | null };

const BRANCH = /\b(etablissement|établissement|agence|agency|branch|filiale|niederlassung|zweigniederlassung|sucursal|succursale|delegaci[oó]n|division|regional|region)\b/i;
const COUNTRY: Record<string, string[]> = {
  FR: ['france', 'francaise', 'française'], BE: ['belgium', 'belgique', 'belgie', 'belgië'], NL: ['nederland', 'netherlands', 'holland'],
  DE: ['deutschland', 'germany'], AT: ['austria', 'österreich', 'osterreich'], CH: ['schweiz', 'suisse', 'switzerland'],
  DK: ['danmark', 'denmark'], NO: ['norge', 'norway'], SE: ['sverige', 'sweden'], FI: ['suomi', 'finland'],
  GB: ['uk', 'united kingdom', 'great britain'], IE: ['ireland', 'eire'], ES: ['espana', 'españa', 'spain', 'iberica', 'ibérica'],
  PT: ['portugal'], IT: ['italia', 'italy'], PL: ['polska', 'poland'], CZ: ['cesko', 'česko', 'czech'], SK: ['slovensko', 'slovakia'],
  RO: ['romania', 'românia'], HU: ['magyarorszag', 'hungary'], HR: ['hrvatska', 'croatia'], SI: ['slovenija', 'slovenia'],
  EE: ['eesti', 'estonia'], LV: ['latvija', 'latvia'], LT: ['lietuva', 'lithuania'], BG: ['bulgaria', 'bulgaria'], GR: ['hellas', 'greece'],
};
const GENERIC_TLD = /\.(com|net|org|group|global|international|eu|info|biz|co)$/i;
const LEGAL = /\b(sa|sas|sasu|sarl|srl|s\.?r\.?l|nv|bv|gmbh|ag|se|kg|ab|as|a\/s|oy|oyj|spa|s\.?p\.?a|sp\.? z o\.?o\.?|d\.?o\.?o\.?|d\.?d\.?|ltd|limited|plc|inc|llc|e\.?k|co)\b\.?/gi;

/** "colas" from colas.com, "vattenfall" from group.vattenfall.com, "geruestbau-suess" from geruestbau-suess.de. */
export function brandOf(domain: string): string {
  const parts = domain.toLowerCase().replace(/^www\./, '').split('.');
  const sld = parts.length >= 3 && ['co', 'com', 'org', 'net', 'ac', 'gov'].includes(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2] ?? parts[0];
  return sld ?? '';
}

/**
 * LETTERS NFD CANNOT DECOMPOSE, and leaving them out cost a real domain (2026-10-07).
 *
 * `words` folds accents by decomposing and dropping the combining marks, which works for ö, å, ñ and é —
 * every one of those is a base letter plus a mark. **Ø (U+00D8) and Æ (U+00C6) are not**: they are atomic
 * letters with no canonical decomposition, so they survived the fold untouched. The consequence was measured
 * in production rather than imagined: `ØRSTED WIND POWER` was REFUSED orsted.com with "carries nothing of the
 * brand orsted", because "ørsted" does not contain "orsted". Å decomposes, so Scandinavian names happened to
 * work often enough to hide it.
 *
 * Folded to the forms a domain actually uses — ørsted.com, not oersted.com. The residual limit, said out
 * loud: this does not reconcile the Danish and Norwegian spellings of one word (værft / verft), because that
 * is a different word rather than a different encoding, and guessing between them would accept wrong domains
 * to save the odd lookup.
 */
const ATOMIC_LETTERS: [RegExp, string][] = [
  [/ø/g, 'o'], [/æ/g, 'ae'], [/œ/g, 'oe'], [/ß/g, 'ss'], [/þ/g, 'th'], [/ð/g, 'd'],
  [/ł/g, 'l'], [/đ/g, 'd'], [/ħ/g, 'h'], [/ŧ/g, 't'], [/ı/g, 'i'], [/ŋ/g, 'n'],
];

const words = (s: string) => {
  let t = s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const [re, to] of ATOMIC_LETTERS) t = t.replace(re, to);
  return t.replace(LEGAL, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
};

/**
 * Hosts that are a DIRECTORY, EVENT or PLATFORM rather than a company's own site — never a valid answer to
 * "what is this company's website", however confidently a search returns one.
 *
 * MEASURED FROM OUR OWN DATA, not imagined (2026-10-05). Nine unrelated Norwegian companies — Logi Trans,
 * Polaris Offshore Technologies, Marine Technologies, Argus Remote Systems, WindCarrier, Segwell, KOSMOS
 * ENERGY, Olympic Subsea, Vintraleå — all carried `floatingwinddays.com`, a conference, and "Premium" (a
 * membership TIER scraped as a company name) carried `oceanwinds.com`. Both came from member-directory
 * imports, and the pages they came from are on this list too, because a directory's own host is exactly what
 * a search for an obscure member tends to return.
 *
 * The cost of a wrong entry here is a company left with no website, which is recoverable. The cost of a
 * missing entry is contact discovery reading a conference's pages and attributing its people to a company
 * that never employed them — fabrication, which is not. So this errs towards rejecting.
 */
const DIRECTORY_HOSTS = [
  'floatingwinddays.com', 'norwegianoffshorewind.no', 'nedzero.nl', 'windeurope.org', 'offshorewindeurope.com',
  'linkedin.com', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com', 'wikipedia.org',
  'eventbrite.com', 'eventbrite.co.uk', 'crunchbase.com', 'dnb.com', 'bloomberg.com', 'glassdoor.com',
  'indeed.com', 'kompass.com', 'europages.co.uk', 'europages.com', 'yellowpages.com', 'opencorporates.com',
  'companieshouse.gov.uk', 'proff.no', 'purehelp.no', 'bizzdb.com', 'endole.co.uk',
];

/** Words that make a host an event or a listing rather than a business. Kept SHORT; each costs real coverage. */
const DIRECTORY_WORDS = /(^|[-.])(expo|messe|summit|conference|congress|tradefair|members?|directory|awards)([-.]|$)|(winddays|energydays|oildays)/i;

/**
 * Is this host a directory, event or platform rather than a company's own site?
 *
 * Checked on the registrable host AND on the brand, so `www.floatingwinddays.com` and a subdomain both fail.
 */
export function looksLikeDirectory(domain: string): string | null {
  const host = String(domain ?? '').toLowerCase().replace(/^www\./, '').trim();
  if (!host) return null;
  const hit = DIRECTORY_HOSTS.find((d) => host === d || host.endsWith(`.${d}`));
  if (hit) return `${hit} is a directory, event or platform site, not a company's own`;
  const word = host.match(DIRECTORY_WORDS)?.[0];
  if (word) return `"${host}" reads as an event or listing site ("${word.replace(/^[-.]|[-.]$/g, '')}"), not a company's own`;
  return null;
}

/**
 * May a lookup STORE this domain for this company, given who else already holds it?
 *
 * ITEM 48's follow-up, 2026-10-05. Two separate questions were being conflated. `siteScope` answers "is this
 * the group's site rather than this entity's", whose answer is a WARNING on screen — COLAS FRANCE on colas.com
 * and GAC Denmark on gac.com are both stored deliberately, because a group switchboard is still a real number.
 * This answers "is this domain simply WRONG for this company", whose answer is a REFUSAL to store.
 *
 * THE DISCRIMINATOR IS THE BRAND, not containment of one name in the other. `GAC Denmark` and `GAC Norway`
 * both carry the brand `gac`, so they are two entities of one group and the domain is right for both. `Logi
 * Trans AS` carries nothing of `floatingwinddays`, so that domain is not a group site, it is a mistake. The
 * old containment test — "related when one squashed name contains the other" — cannot see this at all, and is
 * defeatable in both directions: a short junk name sits inside a real one ("Energy" inside "KOSMOS ENERGY")
 * and a rebrand shares nothing ("Nadara" and "renantis"). Containment is therefore no longer consulted here.
 */
export function mayStoreDomain(companyName: string, domain: string, holders: string[]): { ok: boolean; reason: string | null } {
  const dir = looksLikeDirectory(domain);
  if (dir) return { ok: false, reason: dir };
  const others = (holders ?? []).filter((h) => squashName(h) && squashName(h) !== squashName(companyName));
  if (!others.length) return { ok: true, reason: null };
  // Already held by someone else: allowed ONLY where this company's own name carries the domain's brand.
  if (onBrandName(companyName, domain)) return { ok: true, reason: null };
  return {
    ok: false,
    reason: `${domain} is already on file for ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` and ${others.length - 3} more` : ''}, and "${companyName}" carries nothing of the brand "${brandOf(domain)}" — so this is the wrong company's site, not a group site`,
  };
}

const squashName = (s: string) => words(String(s ?? '')).replace(/\s+/g, '');

/**
 * Does the company's name carry the domain's brand anywhere in it?
 *
 * COMPARED SQUASHED, and that is not cosmetic — the first version compared a SPACED name against a squashed
 * brand and broke two assertions this file already had: "Siemens Gamesa Renewable Energy" does not *start
 * with* "siemensgamesa" once the space is there, and "NIDEC SSB Wind Systems" carries the brand
 * "ssbwindsystems" in the MIDDLE rather than at the front. Both are one company with its own site, so a test
 * that calls them different would have refused real domains. Squashed `includes` handles both.
 *
 * The residual looseness, said out loud: a brand of three or four characters can appear inside an unrelated
 * name by chance. The minimum of three is there because `brandOf` returns the second-level domain, which is
 * almost never shorter, and the consequence of a false accept here is only that a shared domain is stored
 * with a group-site warning instead of refused — the cautious direction.
 */
export function onBrandName(companyName: string, domain: string): boolean {
  const brand = squashName(brandOf(domain).replace(/-/g, ' '));
  const name = squashName(companyName);
  // BOTH DIRECTIONS, because the brand is not always the shorter of the two: "Winergy" sits inside the brand
  // "winergy-group", while "ssbwindsystems" sits inside "NIDEC SSB Wind Systems". Requiring one direction
  // only broke whichever case it was not written for — both were already asserted in site-scope-check.
  if (brand.length < 3 || name.length < 3) return false;
  return name.includes(brand) || brand.includes(name);
}

export function siteScope(input: { companyName: string; domain: string; winnerCountry?: string | null; sharedWith?: string[] }): SiteScope {
  const { companyName, domain } = input;
  const name = words(companyName);
  const brand = brandOf(domain).replace(/-/g, ' ');
  const tld = domain.toLowerCase().split('.').pop() ?? '';
  const onBrand = !!brand && (name.startsWith(brand) || name.split(' ')[0] === brand.split(' ')[0]);

  // A domain on file for another company says "group" only when the two are different entities. The same company stored
  // under two names — "Winergy" and "Winergy / Flender", "NIDEC SSB Wind Systems" and "Nidec SSB Windsystems" — shares its
  // site with itself, and calling that a group site warned about six such pairs on 2026-09-15 (a duplicate-company
  // problem, not a wrong-website one). GAC Denmark and GAC Norway on gac.com are two entities of one group.
  // EXTENDED 2026-10-05: containment alone no longer exempts a sharer, because it is defeatable in both
  // directions. A short junk name sits inside a real one — "Energy" inside "KOSMOS ENERGY" — and a rebrand
  // shares no letters at all — "Nadara" and "renantis". So a contained name is only treated as the same
  // company when BOTH names also carry the domain's own brand, which is what makes "Vestas" and "Vestas
  // Manufacturing" on vestas.com one company and "Energy" and "KOSMOS ENERGY" on a conference host two.
  const squash = (s: string) => words(s).replace(/\s+/g, '');
  const others = (input.sharedWith ?? []).filter((o) => {
    const a = squash(o), b = squash(companyName);
    if (!a || !b) return false;
    const contained = a.includes(b) || b.includes(a);
    if (!contained) return true;
    // EITHER name carrying the domain's brand is enough to make a contained pair one brand family:
    // "Winergy / Flender" carries nothing of "winergy-group" while "Winergy" plainly does, and demanding
    // BOTH broke that pair. What it still refuses is containment with no brand behind it at all — "Energy"
    // inside "KOSMOS ENERGY" on a conference host, where neither name has anything to do with the domain.
    return !(onBrandName(o, domain) || onBrandName(companyName, domain));
  });
  if (others.length) {
    return { scope: 'group', reason: `${domain} is also on file for ${others.slice(0, 2).join(' and ')}, so it is not ${companyName}'s alone` };
  }
  const branchWord = companyName.match(BRANCH)?.[0];
  if (branchWord && onBrand) {
    return { scope: 'group', reason: `"${companyName}" names ${/etablissement|établissement/i.test(branchWord) ? 'an establishment' : `a ${branchWord.toLowerCase()}`} of a larger company, and ${domain} is the company's site, not that ${/etablissement|établissement/i.test(branchWord) ? 'establishment' : branchWord.toLowerCase()}'s` };
  }
  const country = Object.entries(COUNTRY).find(([, ws]) => ws.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(name)));
  if (country && onBrand) {
    const [cc, ws] = country;
    const ownCountryDomain = tld === cc.toLowerCase() || (cc === 'GB' && tld === 'uk');
    if (!ownCountryDomain && (GENERIC_TLD.test(domain) || tld.length === 2)) {
      const printed = ws.find((w) => new RegExp(`\\b${w}\\b`, 'i').test(name))!;
      return { scope: 'group', reason: `the winner is the ${printed.replace(/^./, (x) => x.toUpperCase())} entity, and ${domain} is the ${brand.toUpperCase()} group's ${GENERIC_TLD.test(domain) ? 'international' : 'foreign'} site` };
    }
  }
  return { scope: 'own', reason: null };
}
