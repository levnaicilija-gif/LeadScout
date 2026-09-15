/**
 * A tender winner's own postal address, read from the notice's published XML.
 *
 * The TED search API fields the award ingest asks for give the place of performance (`place-of-performance-city-lot`),
 * which is the contract's site — often the buyer's — not where the winner is. Resolving a winner's website by that town
 * would add exactly the false matches a location is meant to remove. The eForms XML carries every organisation in the
 * procedure with its PostalAddress, and the award section says which organisation won: `efac:TenderingParty` →
 * `efac:Tenderer` → an `ORG-…` id. ALLEZ ENERGIES (notice 609867-2026) is ORG-0005, "Ld La Nautiere, 16260
 * Chasseneuil-Sur-Bonnieure", while the same notice lists the buyer in Angoulême and a review court in Poitiers.
 *
 * The winner is found through that link; an exact company-name match is used only when the notice links no tenderer.
 * Nothing is inferred: a field the notice does not fill stays null.
 *
 * The XML is TED's own published download for each notice (ted.europa.eu/en/notice/<number>/xml) — the official
 * document, fetched plainly, one request every 1.1 s like the search API.
 */
import { canonCompany } from '@/lib/company-identity';

export type WinnerAddress = {
  orgId: string; name: string; street: string | null; postalCode: string | null; city: string | null;
  /** ISO 3166 alpha-3 as the notice writes it, e.g. "FRA". */
  country: string | null; nuts: string | null; companyId: string | null;
};

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
const one = (block: string, re: RegExp) => { const m = block.match(re); return m ? decode(m[1]) || null : null; };

export function organisationsIn(xml: string): WinnerAddress[] {
  return xml.split('<efac:Organization>').slice(1).map((b) => b.split('</efac:Organization>')[0]).map((o) => {
    const address = o.match(/<cac:PostalAddress>([\s\S]*?)<\/cac:PostalAddress>/)?.[1] ?? '';
    return {
      orgId: one(o, /<cbc:ID schemeName="organization">([^<]*)</) ?? '',
      name: one(o, /<cac:PartyName>\s*<cbc:Name[^>]*>([^<]*)<\/cbc:Name>/) ?? '',
      street: one(address, /<cbc:StreetName>([^<]*)</),
      postalCode: one(address, /<cbc:PostalZone>([^<]*)</),
      city: one(address, /<cbc:CityName>([^<]*)</),
      country: one(address, /<cac:Country>\s*<cbc:IdentificationCode[^>]*>([^<]*)</),
      nuts: one(address, /<cbc:CountrySubentityCode[^>]*>([^<]*)</),
      companyId: one(o, /<cac:PartyLegalEntity>[\s\S]*?<cbc:CompanyID[^>]*>([^<]*)</),
    };
  }).filter((o) => o.orgId);
}

/** The organisation ids the notice names as tenderers in its award section. */
export function tendererIds(xml: string): string[] {
  const parties = xml.match(/<efac:TenderingParty>[\s\S]*?<\/efac:TenderingParty>/g) ?? [];
  return [...new Set(parties.flatMap((p) => [...p.matchAll(/<efac:Tenderer>\s*<cbc:ID schemeName="organization">([^<]*)</g)].map((m) => m[1])))];
}

/** The winner's address: a linked tenderer whose name is the winner's, else the only linked tenderer, else an exact name match. */
export function winnerAddress(xml: string, winnerName: string): WinnerAddress | null {
  const orgs = organisationsIn(xml);
  const key = canonCompany(winnerName);
  const tenderers = tendererIds(xml).map((id) => orgs.find((o) => o.orgId === id)).filter((o): o is WinnerAddress => !!o);
  return tenderers.find((o) => canonCompany(o.name) === key)
    ?? (tenderers.length === 1 ? tenderers[0] : null)
    ?? orgs.find((o) => canonCompany(o.name) === key)
    ?? null;
}

/** "609867-2026" from a lead or article URL such as https://ted.europa.eu/en/notice/-/detail/609867-2026#winner-2. */
export const publicationNumber = (url: string | null | undefined) => String(url ?? '').match(/(\d{3,}-\d{4})/)?.[1] ?? null;

let lastAt = 0;
export async function fetchNoticeXml(publication: string): Promise<string | null> {
  const wait = lastAt + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAt = Date.now();
  const res = await fetch(`https://ted.europa.eu/en/notice/${publication}/xml`, { headers: { accept: 'application/xml' }, cache: 'no-store' }).catch(() => null);
  if (!res || !res.ok) return null;
  const text = await res.text();
  return text.includes('<efac:Organization>') ? text : null;
}
