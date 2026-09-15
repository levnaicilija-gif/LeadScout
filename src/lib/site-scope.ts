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

const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(LEGAL, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

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
  const squash = (s: string) => words(s).replace(/\s+/g, '');
  const others = (input.sharedWith ?? []).filter((o) => { const a = squash(o), b = squash(companyName); return !!a && !!b && !a.includes(b) && !b.includes(a); });
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
