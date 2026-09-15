/** A tender winner's own address from a notice's XML, never the buyer's or a court's: npx tsx scripts/winner-address-check.ts */
import { readFileSync } from 'fs';
import { winnerAddress, organisationsIn, tendererIds, publicationNumber } from '../src/lib/tender/winner-address';
import { lookupPrompt } from '../src/lib/domain-lookup';

let failed = 0;
const check = (ok: boolean, what: string, got?: unknown) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` — ${JSON.stringify(got)}`}`); if (!ok) failed++; };

const xml = readFileSync('scripts/fixtures/ted-609867-2026.xml', 'utf8');
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

console.log(failed ? `\n${failed} failed` : '\nwinner address: all checks passed');
process.exitCode = failed ? 1 : 0;
