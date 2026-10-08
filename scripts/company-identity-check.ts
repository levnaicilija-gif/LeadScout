/**
 * Pins what counts as the same company name. No database, no network.
 *
 *   npx tsx scripts/company-identity-check.ts
 *
 * Exits 1 on any failure.
 */
import { canonCompany, sameCompany } from '../src/lib/company-identity';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const same = (a: string, b: string) => sameCompany({ name: a }, { name: b }).same;

check(canonCompany('ЕКОВАТ - БЪЛГАРИЯ ЕООД') === 'ековат българия еоод', 'a Cyrillic winner keeps its name', JSON.stringify(canonCompany('ЕКОВАТ - БЪЛГАРИЯ ЕООД')));
check(same('ЕКОВАТ - БЪЛГАРИЯ ЕООД', 'Ековат – България ЕООД'), 'the same Cyrillic name, cased and punctuated differently, is one company');
check(!same('ЕКОВАТ - БЪЛГАРИЯ ЕООД', 'ЕКОСТРОЙ ЕООД'), 'two different Cyrillic names are two companies');
check(canonCompany('Ørsted Wind') === 'orsted wind', 'ø is folded to o, never turned into a space', JSON.stringify(canonCompany('Ørsted Wind')));
check(!same('Ørsted Wind', 'rsted Wind'), 'Ørsted and "rsted" are not the same name');
// Item 55 (owner, 2026-10-08): the atomic letters NFD cannot decompose are folded, as site-scope already does.
// Each pair below is a real duplicate found in the companies table by the measurement that justified the fold.
check(same('Ørsted', 'Orsted') && same('ØRSTED WIND POWER', 'ORSTED WIND POWER'), 'Ø folds: Ørsted and Orsted are one name');
check(same('Rambøll', 'Ramboll') && same('Vårgrønn', 'Vargronn'), 'and so are Rambøll / Ramboll and Vårgrønn / Vargronn');
check(same('Sund & Bælt', 'Sund & Baelt') && same('Andreas Süß Gerüstbau GmbH', 'Andreas Suss Gerustbau'),
  'Æ folds to ae and ß to ss', `${canonCompany('Sund & Bælt')} / ${canonCompany('Andreas Süß Gerüstbau GmbH')}`);
check(same('Agencja Rozwoju Przemysłu', 'Agencja Rozwoju Przemyslu'), 'Ł folds to l');
// The other arm: the fold is an ENCODING rule, never a spelling guess, so it must not widen past that.
check(!same('Søby Værft', 'Søby Verft'), 'a different WORD stays different: værft is not verft', `${canonCompany('Søby Værft')} / ${canonCompany('Søby Verft')}`);
check(!same('Ørsted', 'Oersted'), 'ø folds to o, the form domains use — not to oe');
check(!same('Rambøll', 'Ramboll Management Consulting'), 'and descriptive words still separate a folded name from its neighbour');
check(canonCompany('ЕКОВАТ - БЪЛГАРИЯ ЕООД') === 'ековат българия еоод', 'a non-Latin script is still never transliterated');
check(canonCompany('Søas AS') === 'soas', 'a legal form is stripped only as a whole word, in any script', JSON.stringify(canonCompany('Søas AS')));
check(same('Equinor', 'Equinor ASA') && same('AF Gruppen ASA', 'AF Gruppen AS'), 'legal forms still strip as before');
check(same('Brüel & Kjær Vibro', 'Bruel & Kjær Vibro'), 'accents still strip as before');
check(!same('Shell', 'Shell Energy'), 'descriptive words still count');
check(canonCompany('AS') === '', 'a name that is only a legal form leaves nothing comparable');

console.log(failures === 0 ? '\ncompany identity: all checks passed' : `\ncompany identity: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
