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
check(canonCompany('Ørsted Wind') === 'ørsted wind', 'ø is kept, not turned into a space', JSON.stringify(canonCompany('Ørsted Wind')));
check(!same('Ørsted Wind', 'rsted Wind'), 'Ørsted and "rsted" are no longer the same name');
check(!same('Ørsted', 'Orsted'), 'nothing is transliterated: Ørsted and Orsted stay two spellings');
check(canonCompany('Søas AS') === 'søas', 'a legal form is stripped only as a whole word, in any script', JSON.stringify(canonCompany('Søas AS')));
check(same('Equinor', 'Equinor ASA') && same('AF Gruppen ASA', 'AF Gruppen AS'), 'legal forms still strip as before');
check(same('Brüel & Kjær Vibro', 'Bruel & Kjær Vibro'), 'accents still strip as before');
check(!same('Shell', 'Shell Energy'), 'descriptive words still count');
check(canonCompany('AS') === '', 'a name that is only a legal form leaves nothing comparable');

console.log(failures === 0 ? '\ncompany identity: all checks passed' : `\ncompany identity: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
