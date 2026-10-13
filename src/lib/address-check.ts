import * as cheerio from 'cheerio';
import type { WinnerAddress } from './tender/winner-address';

/**
 * Does a found website print the award notice's postcode or town? Free — page fetches only, no model call.
 *
 * Moved out of scripts/resolve-wonwork-domains.ts unchanged (2026-10-12) so the tender chain
 * (src/lib/jobs/tender-chain.ts) and the script run ONE implementation: two copies of a check that decides
 * whether a website is labelled confirmed would drift, and the drifted one would be the one nobody reads.
 *
 *   printed            the home page, or one of up to three contact / imprint / about pages it links, prints it
 *   not_printed        the site loaded and printed neither — stored, but labelled unconfirmed (site-trust.ts)
 *   site_did_not_load  the home page did not answer
 *   no_address         the notice gave no postcode or town to look for
 */
export type AddressCheck = 'printed' | 'not_printed' | 'site_did_not_load' | 'no_address';

async function html(url: string) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 LeadScout' }, redirect: 'follow', signal: AbortSignal.timeout(15000) }).catch(() => null);
  return res && res.ok ? await res.text().catch(() => '') : '';
}
const textOf = (h: string) => { const $ = cheerio.load(h); $('script, style, noscript').remove(); return $('body').text().replace(/\s+/g, ' '); };

export async function addressCheck(domain: string, a: WinnerAddress | null): Promise<AddressCheck> {
  const wants = [a?.postalCode, a?.city?.split(/[-\s]/)[0]].filter((w): w is string => !!w && w.length >= 3).map((w) => w.toLowerCase());
  if (!wants.length) return 'no_address';
  const home = await html(`https://${domain}`);
  if (!home) return 'site_did_not_load';
  if (wants.some((w) => textOf(home).toLowerCase().includes(w))) return 'printed';
  const $ = cheerio.load(home);
  const links = [...new Set($('a[href]').map((_, x) => $(x).attr('href') ?? '').get().filter((h) => /contact|kontakt|impressum|imprint|mentions|legal|about|over-ons|om-oss|o-nas|chi-siamo|empresa/i.test(h)))].slice(0, 3);
  for (const l of links) {
    const url = l.startsWith('http') ? l : `https://${domain}${l.startsWith('/') ? '' : '/'}${l}`;
    const text = textOf(await html(url)).toLowerCase();
    if (wants.some((w) => text.includes(w))) return 'printed';
  }
  return 'not_printed';
}

/** The notice's postcode and town as stored beside the check, or null when it gave neither. */
export const checkedAddress = (a: WinnerAddress | null) => (a && (a.city || a.postalCode) ? [a.postalCode, a.city].filter(Boolean).join(' ') : null);
