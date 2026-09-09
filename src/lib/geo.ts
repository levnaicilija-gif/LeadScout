/**
 * Geography is a gate, not a score component.
 *
 * Europe = EU 27 + UK + Norway + Iceland + Switzerland. A company or project outside it is
 * stored (it is still evidence) but never crawled, capped at fit 25, and can never reach Today.
 * The priority tier is where RFBT actually supplies people, and gets the daily cadence.
 */
export const EU27 = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'] as const;
export const EUROPE = [...EU27, 'GB', 'NO', 'IS', 'CH'] as const;
export const PRIORITY = ['DK', 'NO', 'SE', 'NL', 'BE', 'DE', 'GB', 'IE', 'ES', 'FR', 'PL', 'FI'] as const;

/** Ceiling for anything outside Europe — below every Today threshold. */
export const NON_EUROPE_MAX_FIT = 25;

const norm = (cc?: string | null) => {
  const c = (cc ?? '').trim().toUpperCase();
  return c === 'UK' ? 'GB' : c === 'EL' ? 'GR' : c;
};

export const isEuropean = (cc?: string | null) => EUROPE.includes(norm(cc) as any);
export const isPriority = (cc?: string | null) => PRIORITY.includes(norm(cc) as any);
export const tierFor = (cc?: string | null): 'priority' | 'europe' | 'outside' =>
  isPriority(cc) ? 'priority' : isEuropean(cc) ? 'europe' : 'outside';
export const regionFor = (cc?: string | null): 'europe' | 'non_europe' | 'unknown' =>
  !norm(cc) ? 'unknown' : isEuropean(cc) ? 'europe' : 'non_europe';

/** Country names and demonyms as they appear in article text, to an ISO code. */
const NAMES: Record<string, string> = {
  denmark: 'DK', danish: 'DK', dansk: 'DK', copenhagen: 'DK', esbjerg: 'DK', aalborg: 'DK', aarhus: 'DK', lindo: 'DK',
  norway: 'NO', norwegian: 'NO', norsk: 'NO', oslo: 'NO', stavanger: 'NO', bergen: 'NO', haugesund: 'NO',
  sweden: 'SE', swedish: 'SE', stockholm: 'SE', gothenburg: 'SE', malmo: 'SE',
  netherlands: 'NL', dutch: 'NL', holland: 'NL', rotterdam: 'NL', amsterdam: 'NL', eemshaven: 'NL', vlissingen: 'NL', ijmuiden: 'NL',
  belgium: 'BE', belgian: 'BE', antwerp: 'BE', ostend: 'BE', oostende: 'BE', zeebrugge: 'BE',
  germany: 'DE', german: 'DE', cuxhaven: 'DE', bremerhaven: 'DE', rostock: 'DE', hamburg: 'DE', emden: 'DE', nordenham: 'DE',
  'united kingdom': 'GB', uk: 'GB', britain: 'GB', british: 'GB', england: 'GB', scotland: 'GB', scottish: 'GB', wales: 'GB',
  'northern ireland': 'GB', aberdeen: 'GB', teesside: 'GB', hartlepool: 'GB', hull: 'GB', grimsby: 'GB', lowestoft: 'GB',
  methil: 'GB', norfolk: 'GB', humber: 'GB', tyneside: 'GB', aberdeenshire: 'GB',
  ireland: 'IE', irish: 'IE', dublin: 'IE', cork: 'IE',
  spain: 'ES', spanish: 'ES', cadiz: 'ES', bilbao: 'ES', vigo: 'ES', ferrol: 'ES', avilés: 'ES', aviles: 'ES',
  france: 'FR', french: 'FR', 'saint-nazaire': 'FR', 'le havre': 'FR', dunkirk: 'FR', cherbourg: 'FR',
  poland: 'PL', polish: 'PL', gdansk: 'PL', gdynia: 'PL', szczecin: 'PL',
  finland: 'FI', finnish: 'FI', helsinki: 'FI', turku: 'FI', rauma: 'FI',
  italy: 'IT', italian: 'IT', portugal: 'PT', portuguese: 'PT', greece: 'GR', greek: 'GR', thisvi: 'GR',
  estonia: 'EE', latvia: 'LV', lithuania: 'LT', romania: 'RO', bulgaria: 'BG', croatia: 'HR', rijeka: 'HR',
  czechia: 'CZ', 'czech republic': 'CZ', slovakia: 'SK', slovenia: 'SI', hungary: 'HU', austria: 'AT',
  iceland: 'IS', switzerland: 'CH', swiss: 'CH', luxembourg: 'LU', malta: 'MT', cyprus: 'CY',
  // Common non-European mentions, so the gate can act rather than shrug.
  india: 'IN', indian: 'IN', mumbai: 'IN', china: 'CN', chinese: 'CN', japan: 'JP', korea: 'KR',
  taiwan: 'TW', vietnam: 'VN', indonesia: 'ID', malaysia: 'MY', singapore: 'SG', thailand: 'TH',
  'saudi arabia': 'SA', saudi: 'SA', qatar: 'QA', uae: 'AE', 'united arab emirates': 'AE', oman: 'OM', kuwait: 'KW',
  brazil: 'BR', mexico: 'MX', canada: 'CA', 'united states': 'US', usa: 'US', 'u.s.': 'US', america: 'US',
  american: 'US', australia: 'AU', angola: 'AO', nigeria: 'NG', egypt: 'EG', mozambique: 'MZ',
  guyana: 'GY', suriname: 'SR', 'south africa': 'ZA', turkey: 'TR', ukraine: 'UA',
};

/**
 * Best-effort country from free text (a project location, an address). Longest name first so
 * "united kingdom" wins over "uk" inside another word. Returns undefined rather than guessing.
 */
export function countriesFromText(text?: string | null): string[] {
  const t = (text ?? '').toLowerCase();
  if (!t.trim()) return [];
  const out: string[] = [];
  const keys = Object.keys(NAMES).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const re = new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`, 'i');
    if (re.test(t) && !out.includes(NAMES[k])) out.push(NAMES[k]);
  }
  return out;
}

/**
 * The country that decides whether RFBT can staff this.
 *
 * A location often names two: where the asset ends up and where the steel is actually worked.
 * "Mozambique (offshore); manufacturing at Thisvi, Greece" is a Greek fabrication job — the
 * welders are in Greece. So when several countries appear, the European one wins; the trades
 * follow the yard, not the field.
 */
export function countryFromText(text?: string | null): string | undefined {
  const all = countriesFromText(text);
  return all.find((c) => isEuropean(c)) ?? all[0];
}
