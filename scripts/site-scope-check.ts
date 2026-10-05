/** A group's website is told apart from the winning entity's own: npx tsx scripts/site-scope-check.ts */
import { siteScope, looksLikeDirectory, mayStoreDomain, brandOf } from '../src/lib/site-scope';

let failed = 0;
const check = (ok: boolean, what: string, got?: unknown) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` — ${JSON.stringify(got)}`}`); if (!ok) failed++; };

check(brandOf('colas.com') === 'colas' && brandOf('group.vattenfall.com') === 'vattenfall' && brandOf('arklowmarine.ie') === 'arklowmarine' && brandOf('example.co.uk') === 'example', 'the brand is the domain\'s own name, whatever the subdomain or suffix');

// Batch 1 (2026-09-15), as found.
let s = siteScope({ companyName: 'COLAS FRANCE', domain: 'colas.com', winnerCountry: 'FR' });
check(s.scope === 'group' && /France entity/.test(s.reason ?? '') && /COLAS group's international site/.test(s.reason ?? ''), 'COLAS FRANCE → colas.com is the group\'s site', s);
s = siteScope({ companyName: 'COLAS France ETABLISSEMENT COTE BASQUE', domain: 'colas.fr', winnerCountry: 'FR' });
check(s.scope === 'group' && /an establishment/.test(s.reason ?? ''), 'an ETABLISSEMENT of COLAS France → colas.fr is the company\'s site, not the establishment\'s', s);
s = siteScope({ companyName: 'Aellia Belgium NV (anciennement Intero the Sniffers)', domain: 'aellia.com', winnerCountry: 'BE' });
check(s.scope === 'group' && /Belgium entity/.test(s.reason ?? ''), 'Aellia Belgium NV → aellia.com is the group\'s site', s);
s = siteScope({ companyName: 'CHINA CIVIL ENGINEERING CONSTRUCTION CORPORATION ROMANIA SRL', domain: 'ccecc.ro', winnerCountry: 'RO' });
check(s.scope === 'own', 'a country entity on its own country\'s domain is its own site (… ROMANIA SRL → ccecc.ro)', s);
check(siteScope({ companyName: 'Bechtel', domain: 'bechtel.com' }).scope === 'own', 'a company named just its brand is not flagged (Bechtel → bechtel.com)');
check(siteScope({ companyName: 'ALLEZ ENERGIES', domain: 'allez.fr', winnerCountry: 'FR' }).scope === 'own', 'no country or branch in the name: not a group call (ALLEZ ENERGIES → allez.fr — its address check is a separate question)');
check(siteScope({ companyName: 'AWN Stahl- und Metallbau GmbH', domain: 'awn-stahl.de', winnerCountry: 'DE' }).scope === 'own', 'a plain German company on its own .de is its own site');
check(siteScope({ companyName: 'Baltic Marine Contractors OÜ', domain: 'balticmarine.net', winnerCountry: 'EE' }).scope === 'own', 'a generic domain alone is not a group site');
// The brand must be the winner's: a country word in a name that is not on that brand says nothing.
check(siteScope({ companyName: 'France Travaux Maritimes', domain: 'ftm-travaux.com', winnerCountry: 'FR' }).scope === 'own', 'a country word in a name on another brand is not a group call');
s = siteScope({ companyName: 'Nordic Cranes AS', domain: 'nordic-group.com', winnerCountry: 'NO', sharedWith: ['Nordic Offshore AS'] });
check(s.scope === 'group' && /also on file for Nordic Offshore AS/.test(s.reason ?? ''), 'a domain already on file for a differently named company is not the winner\'s alone', s);

// The backfill of 2026-09-15 flagged the same company stored twice as a group site. It is not.
check(siteScope({ companyName: 'Winergy', domain: 'winergy-group.com', sharedWith: ['Winergy / Flender'] }).scope === 'own', 'the same company under two names shares its site with itself (Winergy / "Winergy / Flender")');
check(siteScope({ companyName: 'NIDEC SSB Wind Systems', domain: 'ssbwindsystems.de', sharedWith: ['Nidec SSB Windsystems'] }).scope === 'own', 'a spacing variant of the same name is the same company (NIDEC SSB Wind Systems / Nidec SSB Windsystems)');
check(siteScope({ companyName: 'Siemens Gamesa Renewable Energy', domain: 'siemensgamesa.com', sharedWith: ['Siemens Gamesa'] }).scope === 'own', 'a longer form of the same name is the same company (Siemens Gamesa Renewable Energy / Siemens Gamesa)');
s = siteScope({ companyName: 'GAC Denmark', domain: 'gac.com', winnerCountry: 'DK', sharedWith: ['GAC Norway'] });
check(s.scope === 'group', 'two country entities on one site are a group (GAC Denmark / GAC Norway on gac.com)', s);

// ---- MAY A LOOKUP STORE THIS DOMAIN? Both arms on every rule ------------------------------------------
// The question siteScope answers is "own or the group's", whose answer is a WARNING. This is the different
// question "is this domain simply WRONG for this company", whose answer is a REFUSAL to store. Every string
// below is real: the nine companies on floatingwinddays.com and "Premium" on oceanwinds.com were found in the
// live table on 2026-10-05, both from member-directory imports.
console.log('\n--- a directory or another company\'s site is REFUSED, a group site is NOT ---');

// 1. DIRECTORY AND EVENT HOSTS. The arm that matters is the second: a real company domain must survive.
for (const [d, why] of [['floatingwinddays.com', 'the conference nine unrelated companies were pointed at'],
  ['www.floatingwinddays.com', 'the www form too'], ['norwegianoffshorewind.no', 'the members directory itself'],
  ['nedzero.nl', 'the directory "Premium" came from'], ['linkedin.com', 'a platform'],
  ['some-expo.de', 'an expo host'], ['acme-summit.com', 'a summit host']] as [string, string][]) {
  check(!!looksLikeDirectory(d), `${d} is refused — ${why}`, looksLikeDirectory(d));
}
for (const d of ['aibel.com', 'nordex-online.com', 'siemensgamesa.com', 'karstensens.dk', 'fse-stahlbau.de',
  'vestas.com', 'gac.com', 'oceanwinds.com', 'mth.dk', 'holidayinn-engineering.com']) {
  check(!looksLikeDirectory(d), `${d} is NOT refused — a real company site must survive the rule`, looksLikeDirectory(d));
}

// 2. ALREADY HELD BY AN UNRELATED COMPANY. The brand decides, not containment.
let m = mayStoreDomain('Logi Trans AS', 'floatingwinddays.com', ['Polaris Offshore Technologies', 'KOSMOS ENERGY']);
check(!m.ok && /directory, event or platform/.test(m.reason ?? ''), 'Logi Trans on a conference host is refused as a DIRECTORY first', m);
m = mayStoreDomain('Premium', 'oceanwinds.com', ['Ocean Winds']);
check(!m.ok && /carries nothing of the brand/.test(m.reason ?? ''), '"Premium" is refused oceanwinds.com — it carries nothing of the brand', m);
m = mayStoreDomain('Logi Trans AS', 'olympic.no', ['Olympic Subsea ASA']);
check(!m.ok, 'and the rule works on an ordinary domain too, not only a listed host', m);
// THE OTHER ARM, AND IT IS THE ONE THAT PROTECTS COVERAGE: a group site is still storable.
m = mayStoreDomain('GAC Denmark', 'gac.com', ['GAC Norway']);
check(m.ok, 'GAC Denmark may still store gac.com — two entities of one group, which siteScope warns about separately', m);
m = mayStoreDomain('Vestas Manufacturing', 'vestas.com', ['VESTAS']);
check(m.ok, 'Vestas Manufacturing may store vestas.com', m);
m = mayStoreDomain('COLAS FRANCE', 'colas.com', ['COLAS']);
check(m.ok, 'COLAS FRANCE may store colas.com — the group-site warning is not a refusal', m);
m = mayStoreDomain('Karstensens Skibsvaerft', 'karstensens.dk', []);
check(m.ok, 'and a domain nobody else holds is always storable', m);

// 3. CONTAINMENT NO LONGER DEFEATS THE SHARED RULE. A short name inside a longer one is not evidence of
// one company when neither name carries the domain's brand — "Energy" inside "KOSMOS ENERGY" on a
// conference host used to exempt itself and read as 'own'.
let sc = siteScope({ companyName: 'KOSMOS ENERGY', domain: 'floatingwinddays.com', sharedWith: ['Energy'] });
check(sc.scope === 'group', 'a contained name that carries none of the brand is STILL a different company', sc);
sc = siteScope({ companyName: 'Vestas Manufacturing', domain: 'vestas.com', sharedWith: ['VESTAS'] });
check(sc.scope === 'own', 'while a contained name that DOES carry the brand is still the same company', sc);

console.log(failed ? `\n${failed} failed` : '\nsite scope: all checks passed');
process.exitCode = failed ? 1 : 0;
