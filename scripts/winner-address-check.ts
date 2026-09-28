/** A tender winner's own address from a notice's XML, never the buyer's or a court's: npx tsx scripts/winner-address-check.ts */
import { readFileSync } from 'fs';
import { winnerAddress, organisationsIn, tendererIds, publicationNumber } from '../src/lib/tender/winner-address';
import { lookupPrompt, placeFrom } from '../src/lib/domain-lookup';

let failed = 0;
const check = (ok: boolean, what: string, got?: unknown) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` — ${JSON.stringify(got)}`}`); if (!ok) failed++; };

const xml = readFileSync('scripts/testdata/ted-609867-2026.xml', 'utf8');
check(organisationsIn(xml).length === 5, 'the notice lists five organisations', organisationsIn(xml).map((o) => o.name));
check(JSON.stringify(tendererIds(xml)) === '["ORG-0005"]', 'the award section links one tenderer, ORG-0005', tendererIds(xml));
const a = winnerAddress(xml, 'ALLEZ ENERGIES');
check(a?.street === 'Ld La Nautiere' && a.postalCode === '16260' && a.city === 'Chasseneuil-Sur-Bonnieure' && a.country === 'FRA' && a.nuts === 'FRI31',
  "ALLEZ ENERGIES' own address: Ld La Nautiere, 16260 Chasseneuil-Sur-Bonnieure, FRA", a);
check(winnerAddress(xml, 'Allez Energies SAS')?.orgId === 'ORG-0005', 'a legal form on the name still finds the linked tenderer', winnerAddress(xml, 'Allez Energies SAS'));
check(winnerAddress(xml, 'Syndicat Départemental d\'Electricité et de Gaz de la Charente (SDEG 16)')?.city !== 'Angouleme Cedex' || tendererIds(xml).length === 1,
  'the buyer is never returned as a winner while a tenderer is linked', winnerAddress(xml, 'SDEG 16'));
check(publicationNumber('https://ted.europa.eu/en/notice/-/detail/609867-2026#winner-2') === '609867-2026', 'the publication number comes off a lead URL with a winner anchor');

const withAddress = lookupPrompt({ name: 'ALLEZ ENERGIES', address: a });
check(/Registered address \(from the contract award notice\): Ld La Nautiere, 16260 Chasseneuil-Sur-Bonnieure, FRA/.test(withAddress), 'the lookup names the address as the notice printed it', withAddress);
check(lookupPrompt({ name: 'ALLEZ ENERGIES', country: 'FR' }) === 'Company: ALLEZ ENERGIES\nCountry: FR', 'without an address the lookup is exactly the name and country, as before', lookupPrompt({ name: 'ALLEZ ENERGIES', country: 'FR' }));

// ---- THE PLACE IN THE SEARCH QUERY (owner's instruction, 2026-09-28) ---------------------------
// Both arms on every rule: what must be in the query, and what must NOT. The street is the "must not":
// name + the FULL address was measured WORSE than name + country on 2026-09-15 (5 domains against 6, 2
// verified against 3, +18% cost), so the town going in must not quietly take the street with it.
const place = placeFrom(a);
check(place?.city === 'Chasseneuil-Sur-Bonnieure' && place?.postalCode === '16260', 'placeFrom keeps the town and the postcode', place);
check(!('street' in (place ?? {})) || (place as any).street == null, 'placeFrom DROPS the street — the part that narrows a web search to nothing', place);
check(place?.country === 'FRA', 'placeFrom keeps the country it was given', place);

const placePrompt = lookupPrompt({ name: 'ALLEZ ENERGIES', country: 'FR', address: place });
check(/Town the contract award notice gives for this company \(its own registered address, not the buyer's\): 16260 Chasseneuil-Sur-Bonnieure, FRA/.test(placePrompt),
  'a place-only lookup says it holds a TOWN, never claiming a registered address it was not given', placePrompt);
check(!/Ld La Nautiere/.test(placePrompt), 'the street never reaches a place-only query', placePrompt);
check(/Company: ALLEZ ENERGIES/.test(placePrompt) && /Country: FR/.test(placePrompt), 'the name and country are still both in the query', placePrompt);

// A NUTS code is a statistical region code no page prints; it must never become the "place".
check(placeFrom({ nuts: 'FRI31', country: 'FRA' }) === null, 'a notice with only a NUTS code names no place', placeFrom({ nuts: 'FRI31', country: 'FRA' }));
check(placeFrom({ street: 'Ld La Nautiere', country: 'FRA' }) === null, 'a street with no town is not a place either', placeFrom({ street: 'Ld La Nautiere', country: 'FRA' }));
check(placeFrom(null) === null && placeFrom(undefined) === null, 'no address at all is no place');
check(placeFrom({ city: '  ', postalCode: null })  === null, 'a blank town is not a town', placeFrom({ city: '  ', postalCode: null }));
check(placeFrom({ postalCode: '25746', city: null })?.postalCode === '25746', 'a postcode alone is still a place', placeFrom({ postalCode: '25746', city: null }));
check(lookupPrompt({ name: 'X', address: placeFrom({ city: null, postalCode: null }) }) === 'Company: X', 'no place leaves the query exactly as it was', lookupPrompt({ name: 'X', address: placeFrom({ city: null, postalCode: null }) }));

console.log(failed ? `\n${failed} failed` : '\nwinner address: all checks passed');
process.exitCode = failed ? 1 : 0;
