/**
 * Whose name is on a document is decided the same way every time (src/lib/name-match.ts#holderFits). No database, no network.
 *
 *   npx tsx scripts/holder-fits-check.ts
 *
 * The first case is the owner's report of 2026-09-15: Paul Daniel Pascale's FROSIO certificate was attached to #9, Bertescu
 * Dumitrel, and nothing asked.
 */
import { holderFits } from '../src/lib/name-match';

let failed = 0;
const expect = (holder: string | null, candidate: string | null, fits: boolean, what: string) => {
  const got = holderFits(holder, candidate);
  const ok = got.fits === fits;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what} — "${holder}" on "${candidate}": ${got.fits ? 'fits' : 'does not fit'} (${got.why})`);
  if (!ok) failed++;
};

expect('Paul Daniel Pascale', 'Bertescu Dumitrel', false, "the owner's report: someone else's certificate does not fit");
expect('Bertescu Dumitrel', 'Bertescu Dumitrel', true, 'the same name fits');
expect('BERTESCU, Dumitrel', 'Bertescu Dumitrel', true, 'case and punctuation do not matter');
expect('Dumitrel Bertescu', 'Bertescu Dumitrel', true, 'order does not matter');
expect('PEPLIŃSKI, Szymon', 'Szymon Peplinski', true, 'accents do not matter');
expect('Paul Daniel Pascale', 'Paul Pascale', true, 'a middle name only one side carries still fits');
expect('M. Marcu', 'Marian Marcu', true, 'a first name written as an initial still fits');
expect('Ion Marcu', 'Marian Marcu', false, 'a shared surname alone does not fit');
expect('Pascale', 'Paul Daniel Pascale', false, 'a single name word is not enough to say whose document it is');
expect(null, 'Bertescu Dumitrel', false, 'a document with no readable name fits nobody');
expect('Paul Daniel Pascale', null, false, 'a candidate with no name on file cannot be matched');

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nholder-fits: all checks passed');
