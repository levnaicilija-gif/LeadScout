/** A group's website is told apart from the winning entity's own: npx tsx scripts/site-scope-check.ts */
import { siteScope, brandOf } from '../src/lib/site-scope';

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

console.log(failed ? `\n${failed} failed` : '\nsite scope: all checks passed');
process.exitCode = failed ? 1 : 0;
