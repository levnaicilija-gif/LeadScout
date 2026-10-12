/** A group's website is told apart from the winning entity's own: npx tsx scripts/site-scope-check.ts */
import { siteScope, looksLikeDirectory, mayStoreDomain, onBrandName, brandOf, sameGroupHolder } from '../src/lib/site-scope';
import { canonCompany } from '../src/lib/company-identity';

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

// ---- THE LETTERS NFD CANNOT DECOMPOSE (2026-10-07) ---------------------------------------------------
// MEASURED IN PRODUCTION, NOT IMAGINED: the first real batch run under mayStoreDomain REFUSED
// "ØRSTED WIND POWER" the domain orsted.com, saying it "carries nothing of the brand orsted" — because Ø is
// an atomic letter with no canonical decomposition, so the accent fold left "ørsted" alone. Å decomposes,
// which is why Scandinavian names worked often enough to hide this.
console.log('\n--- Ø and Æ fold to the forms a domain actually uses ---');
check(onBrandName('ØRSTED WIND POWER', 'orsted.com'), 'ØRSTED WIND POWER carries the brand orsted — the production false positive');
check(onBrandName('Ørsted', 'orsted.com'), 'and so does Ørsted itself');
check(onBrandName('Ørsted Wind Power A/S', 'orsted.com'), 'with a legal form too');
let st = mayStoreDomain('ØRSTED WIND POWER', 'orsted.com', ['Ørsted']);
check(st.ok, 'so ØRSTED WIND POWER may now STORE orsted.com, which it was refused in the live run', st);
check(onBrandName('Søby Værft A/S', 'soby-vaerft.dk'), 'æ folds to ae, matching how the domain spells it');
check(onBrandName('Hafnarfjörður Þór', 'thor.is'), 'þ folds to th');
// THE OTHER ARM: folding must not make unrelated names match. Both of these refusals were CORRECT in the
// live run and must stay correct — the fold widens matching, so this is where it could do harm.
st = mayStoreDomain('Skagen SSB', 'skagensmaleren.dk', ['Skagen Blade Technology']);
check(!st.ok, 'Skagen SSB is still refused skagensmaleren.dk — a correct refusal from the same live run', st);
check(!onBrandName('Logi Trans AS', 'floatingwinddays.com'), 'and an unrelated name still carries no brand');
check(!onBrandName('Premium', 'oceanwinds.com'), 'nor does a membership tier');

// ---- A GROUP'S SITE IS STORED AS THE GROUP'S, NEVER COUNTED AS A MISS (defects 1 and 2, 2026-10-09) -------
// MEASURED IN PRODUCTION: the 2026-10-08 Industry Contacts run refused five subsidiaries the domain their own
// group already held, paid a retry for four of them, and then marked all five "no website found".
console.log('\n--- a domain the same group holds is stored as the group\'s site ---');
check(brandOf('group.sener') === 'sener', 'a brand TLD is the brand: group.sener → sener, not "group"', brandOf('group.sener'));
check(brandOf('group.vattenfall.com') === 'vattenfall' && brandOf('winergy-group.com') === 'winergy-group' && brandOf('acme.group') === 'acme',
  'and a generic label on an ordinary TLD still is not (group.vattenfall.com, winergy-group.com, acme.group)');
check(brandOf('group.dk') === 'group' && brandOf('careers.online') === 'careers', 'a country or common TLD is never taken as a brand', [brandOf('group.dk'), brandOf('careers.online')]);
let g = mayStoreDomain('Nordex Acciona', 'nordex-online.com', ['Nordex']);
check(g.ok && g.group === 'Nordex' && /same group/.test(g.reason ?? ''), 'Nordex Acciona → nordex-online.com is STORED as the group\'s site (held by Nordex)', g);
g = mayStoreDomain('Nordex Energy Spain', 'nordex-online.com', ['Nordex']);
check(g.ok && g.group === 'Nordex', 'and so is Nordex Energy Spain', g);
g = mayStoreDomain('bp', 'bp.com', ['BP Europe']);
check(g.ok && g.group === 'BP Europe', 'bp → bp.com is stored even though a two-letter name cannot pass the brand test', g);
g = mayStoreDomain('Sener Ingeneniería y Sistemas, S.A.', 'group.sener', ['Sener']);
check(g.ok, 'Sener Ingeniería → group.sener is stored once the brand TLD is read', g);
// THE OTHER ARM: a shared first word is not a group unless the DOMAIN's brand begins with that whole word.
g = mayStoreDomain('SGRE', 'siemensgamesa.com', ['Siemens Gamesa']);
check(!g.ok, 'an abbreviation shares nothing printed and is NOT matched — SGRE stays an owner\'s call, never inferred', g);
g = mayStoreDomain('Wind Power AS', 'windenergyireland.com', ['Wind Energy Ireland']);
check(!g.ok, 'a generic opening word ("wind") does not make a group when the brand is one token (windenergyireland)', g);
g = mayStoreDomain('Skagen SSB', 'skagensmaleren.dk', ['Skagen Blade Technology']);
check(!g.ok && !g.group, 'Skagen SSB is still refused: "skagen" is not the brand "skagensmaleren"', g);
check(sameGroupHolder('Nordex Acciona', 'acciona.com', ['Acciona']) === null, 'and the FIRST word decides: Nordex Acciona is not in the Acciona GROUP by its second word (the older brand rule may still store it)');

// ---- EITHER SPELLING FITS: ø/ö/æ/ä/å/ü/ß folded (o, a, u…) OR written as a digraph (oe, ae, aa, ue, ss) ---------
// Owner's decision 2026-10-12. Measured first: 16 of 166 tender winners with a domain flip, all German ü→ue, and
// HOLBØLL A/S's own site is holboell.dk. Both sides are tested, and the false-positive arms are the point: the
// digraph only ever REPLACES a letter that is there — it never invents one, and a different word stays different.
console.log('\n--- either spelling of a name fits its domain ---');
const fits = (n: string, d: string, want: boolean, why: string) => check(onBrandName(n, d) === want, `${want ? 'FITS' : 'does NOT fit'}: "${n}" ~ ${d} — ${why}`, onBrandName(n, d));
fits('HOLBØLL A/S', 'holboell.dk', true, 'Danish ø written oe (the HOLBØLL notice, 697631-2026)');
fits('HOLBØLL A/S', 'holboll.dk', true, 'and ø folded to o still fits');
fits('HOLBØLL A/S', 'holbøll.dk', true, 'and the letter itself, in an internationalised domain');
fits('Schüttler Gerüstbau GmbH', 'schuettler-geruestbau.de', true, 'German ü written ue — one of the 16 measured flips');
fits('Gerüstbau Stuiber GmbH', 'geruestbau-stuiber.co.de', true, 'ü→ue under a second-level .co.de');
fits('Gröna Räkan AB', 'groenaraekan.se', true, 'Swedish ö and ä written oe and ae');
fits('Gröna Räkan AB', 'gronarakan.se', true, 'and folded to o and a');
fits('Vårgrønn AS', 'vaargroenn.no', true, 'Norwegian å written aa and ø written oe');
fits('Vårgrønn AS', 'vargronn.no', true, 'and both folded');
fits('Mäkelä Oy', 'maekelae.fi', true, 'Finnish ä written ae');
fits('Roßbach Gerüstbau GmbH', 'rossbach-geruestbau.de', true, 'ß→ss and ü→ue together');
// A LIMIT, pinned so nobody reads it as a spelling bug: the brand test is containment of the squashed name, so a
// domain that REORDERS the name's words fails whatever the spelling — "suessgeruestbau" vs brand "geruestbausuess".
fits('Andreas Süß Gerüstbau GmbH', 'geruestbau-suess.de', false, 'word order, not spelling — the existing containment rule, unchanged');
// THE OTHER ARM — nothing is invented, and a different word is not a different encoding.
fits('Holboll A/S', 'holboell.dk', false, 'a name printed WITHOUT ø is never given an oe it does not have');
fits('Muller Bau GmbH', 'mueller-bau.de', false, 'nor a plain u a ue');
fits('Ole Andersen', 'oeland.se', false, 'an oe in a domain is not matched against a name with no ö or ø');
fits('Søby Værft A/S', 'sobyverft.no', false, 'værft is not verft — a different word, not a spelling');
fits('Søby Værft A/S', 'shipyard.dk', false, 'and a site that shares nothing still shares nothing');
fits('Ø AS', 'oe.dk', false, 'and the three-character floor still holds for a digraph spelling');
check(sameGroupHolder('Schüttler Service GmbH', 'schuettler-geruestbau.de', ['Schüttler Gerüstbau GmbH']) === 'Schüttler Gerüstbau GmbH',
  'the group rule reads either spelling too: "Schüttler …" is the schuettler group');
check(sameGroupHolder('Muller Service GmbH', 'mueller-gruppe.de', ['Müller Gruppe GmbH']) === null,
  'and a name without ü is not put in the mueller group by its holder\'s spelling');
// HESS GERÜSTBAU, the one live case where the verdict bites (owner: report before and after, do not merge).
// Before 2026-10-12 neither row was recognised as carrying the brand "hessgeruestbau", so each made the other's
// site a GROUP site. They are one firm under two legal-form spellings; now they read as one brand family.
const hessA = 'Hess Gerüstbau GmbH', hessB = 'Hess Gerüstbau GmbH & Co. KG';
check(siteScope({ companyName: hessA, domain: 'hessgeruestbau.de', sharedWith: [hessB] }).scope === 'own'
  && siteScope({ companyName: hessB, domain: 'hessgeruestbau.de', sharedWith: [hessA] }).scope === 'own',
  'Hess Gerüstbau GmbH and … GmbH & Co. KG on hessgeruestbau.de are one brand family — "own", no longer "group"');
check(mayStoreDomain(hessB, 'hessgeruestbau.de', [hessA]).ok, 'and either may still store it');
check(siteScope({ companyName: 'Hess Elektro GmbH', domain: 'hessgeruestbau.de', sharedWith: [hessA] }).scope === 'group',
  'while a different Hess firm on the same site is still a GROUP site — the shared-domain guard is not loosened');
// canonCompany is deliberately UNCHANGED: company identity keeps ONE canonical form.
check(canonCompany('Schüttler Gerüstbau GmbH') === canonCompany('Schuttler Gerustbau GmbH')
  && canonCompany('Schüttler Gerüstbau GmbH') !== canonCompany('Schuettler Geruestbau GmbH'),
  'canonCompany is unchanged — ü folds to u and is NOT the same name as a ue spelling, so no rows merge',
  [canonCompany('Schüttler Gerüstbau GmbH'), canonCompany('Schuettler Geruestbau GmbH')]);

console.log(failed ? `\n${failed} failed` : '\nsite scope: all checks passed');
process.exitCode = failed ? 1 : 0;
