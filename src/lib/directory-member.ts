/**
 * What a member directory is allowed to tell us about a member — the two judgements that put a conference
 * site on nine companies and a membership tier in the company table.
 *
 * WHAT THE IMPORT DID, read from the code and matched against the rows it produced (2026-10-06):
 *
 * `profile` mode visits each member's own page on the directory and takes `sub.links.find(external)` — the
 * FIRST link leaving the site — as that member's website, with the name from the page `<title>`'s first
 * segment. Both are positional guesses, and both failed on real pages:
 *
 *   - Norwegian Offshore Wind banners its own conference, Floating Wind Days, on every member page. That link
 *     sits above the member's own website in the DOM, so `find` returned it for EVERY profile: NINE companies
 *     — Logi Trans, Polaris Offshore Technologies, Marine Technologies, Argus Remote Systems, WindCarrier,
 *     Segwell, KOSMOS ENERGY, Olympic Subsea, Vintraleå — each with a CORRECT name and `floatingwinddays.com`
 *     as its domain. `membersFromHtml` keys its results by host and so can only ever emit one row per host;
 *     profile mode `push`es, which is why nine rows could share one.
 *   - NedZero's member page titled a membership TIER, so the first title segment was "Premium". That became a
 *     company row named "Premium", carrying another member's domain, `oceanwinds.com`.
 *
 * Neither is a transport error and neither reported anything: the import counted a matched member and moved
 * on. The guards here make both cases SAY SO and store nothing.
 */
import { looksLikeDirectory, onBrandName } from './site-scope';

/**
 * Words that are a membership level, a sponsorship rank or a page heading rather than a company.
 *
 * Anchored to the WHOLE name, never a substring: "Premium" is not a company and "Premium Wind Services AS"
 * plainly is. A tier arriving as a name means the page's title was not the member's name at all, so the right
 * answer is to skip the member rather than to store a guess under a different field.
 */
const TIER_WORDS = [
  'premium', 'gold', 'silver', 'bronze', 'platinum', 'diamond', 'basic', 'standard', 'plus', 'pro',
  'member', 'members', 'membership', 'partner', 'partners', 'sponsor', 'sponsors', 'associate', 'associates',
  'supporter', 'supporters', 'patron', 'friend', 'friends', 'startup', 'start up', 'enterprise', 'corporate',
  'full member', 'associate member', 'affiliate', 'affiliates', 'home', 'members directory', 'directory',
  'our members', 'all members', 'leden', 'medlemmer', 'medlem', 'mitglieder', 'miembros',
];

const canon = (s: string) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** The name is a membership tier or a page heading, not a company. Returns the matched word, else null. */
export function looksLikeMembershipTier(name: string): string | null {
  const n = canon(name);
  if (!n) return null;
  const hit = TIER_WORDS.find((w) => n === w || n === `${w} ${''}`.trim());
  return hit ?? null;
}

export type MemberSite =
  | { host: string; why: string }
  | { host: null; why: string };

/**
 * Which of a member profile's external links is the member's own website?
 *
 * THE FIRST ONE IS NOT THE ANSWER — that is the whole bug. The rule, in order:
 *   1. drop directories, events and platforms outright (`looksLikeDirectory`), which removes the conference
 *      banner, the directory's own sibling sites and every LinkedIn or Facebook link;
 *   2. prefer a host whose brand matches the member's NAME, which is positive evidence rather than position;
 *   3. with exactly one candidate left and no name match, take it — a small directory often links only the
 *      member's site, and refusing that would throw away most of what these imports are for;
 *   4. with several candidates and no name match, STORE NOTHING and say so. A guess here is what produced
 *      nine wrong rows, and an unresolved member costs only a lookup later.
 */
export function pickMemberSite(name: string, hosts: string[]): MemberSite {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const h of hosts) {
    const host = String(h ?? '').toLowerCase().replace(/^www\./, '').trim();
    if (!host || seen.has(host)) continue;
    seen.add(host);
    if (looksLikeDirectory(host)) continue;
    candidates.push(host);
  }
  if (!candidates.length) return { host: null, why: 'every external link on the page is a directory, event or platform' };
  const byName = candidates.find((h) => onBrandName(name, h));
  if (byName) return { host: byName, why: `"${name}" carries the brand of ${byName}` };
  if (candidates.length === 1) return { host: candidates[0], why: `the only non-directory link on the page is ${candidates[0]}` };
  return {
    host: null,
    why: `${candidates.length} external links and none carries "${name}"'s name (${candidates.slice(0, 3).join(', ')}) — the first one is not evidence, so nothing is stored`,
  };
}
