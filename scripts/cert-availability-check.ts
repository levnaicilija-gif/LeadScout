/**
 * An expired certificate takes somebody off the roles that need it — and off nothing else.
 *
 *   npx tsx scripts/cert-availability-check.ts
 *
 * Pure: no database, no network, no model call. In the release gate.
 *
 * Three decisions are pinned here, and each was a fork where the obvious thing would have been wrong:
 *
 *   PER ROLE, NOT GLOBAL. candidates.availability_from is a date meaning "free from", not a flag, and
 *   there is no per-role availability anywhere. A global unavailable would lie in both directions —
 *   blocking work the person can do, and saying nothing about the work they cannot.
 *
 *   COMPUTED, NEVER STORED. Writing this into availability_from would assert something different and
 *   false and would overwrite a real date a recruiter entered. Same rule as lead age and compound
 *   signals, both deliberately unstored.
 *
 *   LAPSED IS NOT "NEVER HELD". Somebody who never had a CSWIP is not unavailable for CSWIP work —
 *   item 11's scoring already says that under `missing`. Somebody whose CSWIP ran out last month was
 *   placeable in August and is not now. Treating the two alike floods the screen with everybody who
 *   does not hold every certificate, which is everybody.
 */
import { unavailableFor, bodiesRequired, lapsedCerts } from '../src/lib/cert-availability';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

const NOW = new Date('2026-09-22T12:00:00Z');
const GONE = '2026-08-15';
const LIVE = '2027-06-01';

console.log('--- reading what the advert asks for ---');
check(bodiesRequired(['CSWIP 3.1']).includes('cswip'), 'CSWIP 3.1 asks for cswip', JSON.stringify(bodiesRequired(['CSWIP 3.1'])));
check(bodiesRequired(['FROSIO Level 3']).includes('frosio'), 'FROSIO Level 3 asks for frosio');
check(bodiesRequired(['ISO 9606-1 welder qualification']).includes('iso9606'), 'an ISO 9606 line asks for iso9606');
check(bodiesRequired([]).length === 0, 'an advert asking for nothing asks for nothing');
check(bodiesRequired(['must be a good team player']).length === 0, 'and prose that names no certificate contributes nothing', JSON.stringify(bodiesRequired(['must be a good team player'])));
check(bodiesRequired(['Blorpex Level 9']).length === 0, 'a requirement nothing recognises is NOT guessed at', JSON.stringify(bodiesRequired(['Blorpex Level 9'])));

console.log('\n--- lapsed takes you off that role ---');
const lapsed = unavailableFor([{ body: 'cswip', validUntil: GONE }], ['CSWIP 3.1'], NOW);
check(lapsed.unavailable, 'a lapsed CSWIP makes somebody unavailable for CSWIP work');
check(lapsed.bodies.includes('cswip'), 'and names the body', JSON.stringify(lapsed.bodies));
check(/CSWIP expired 2026-08-15/.test(lapsed.reasons.join('; ')), 'and says which certificate and when', lapsed.reasons.join('; '));

console.log('\n--- and off nothing else ---');
const other = unavailableFor([{ body: 'cswip', validUntil: GONE }], ['FROSIO Level 3'], NOW);
check(!other.unavailable, 'the same person is still available for work that does not ask for it', JSON.stringify(other.reasons));
const noAsk = unavailableFor([{ body: 'cswip', validUntil: GONE }], [], NOW);
check(!noAsk.unavailable, 'and for a role that asks for no certificate at all');
const unreadable = unavailableFor([{ body: 'cswip', validUntil: GONE }], ['Blorpex Level 9'], NOW);
check(!unreadable.unavailable, 'a requirement nothing can read blocks nobody', JSON.stringify(unreadable.reasons));

console.log('\n--- never held is not unavailable ---');
const never = unavailableFor([], ['CSWIP 3.1'], NOW);
check(!never.unavailable, 'somebody who never held a CSWIP is not "unavailable" for CSWIP work — they are missing it', JSON.stringify(never.reasons));
const otherCert = unavailableFor([{ body: 'frosio', validUntil: LIVE }], ['CSWIP 3.1'], NOW);
check(!otherCert.unavailable, 'and neither is somebody holding a different certificate entirely');

console.log('\n--- a valid one behind it covers you ---');
const both = unavailableFor([{ body: 'cswip', validUntil: GONE }, { body: 'cswip', validUntil: LIVE }], ['CSWIP 3.1'], NOW);
check(!both.unavailable, 'an expired certificate does not cancel a valid one of the same body', JSON.stringify(both.reasons));
const bothGone = unavailableFor([{ body: 'cswip', validUntil: '2026-01-01' }, { body: 'cswip', validUntil: GONE }], ['CSWIP 3.1'], NOW);
check(bothGone.unavailable, 'but when every one of them has run out, that is unavailable');
check(/2026-08-15/.test(bothGone.reasons.join('')), 'and the LATEST expiry is the one quoted, not the oldest', bothGone.reasons.join('; '));

console.log('\n--- the day boundary ---');
check(!unavailableFor([{ body: 'cswip', validUntil: '2026-09-22' }], ['CSWIP 3.1'], NOW).unavailable, 'the last valid day is still valid');
check(unavailableFor([{ body: 'cswip', validUntil: '2026-09-21' }], ['CSWIP 3.1'], NOW).unavailable, 'the day after it is not');
check(!unavailableFor([{ body: 'cswip', validUntil: null }], ['CSWIP 3.1'], NOW).unavailable,
  'a certificate with no date at all does not make somebody unavailable — no date is not the same as expired');

console.log('\n--- the list view, where there is no role in front of you ---');
const lapsedList = lapsedCerts([{ body: 'cswip', validUntil: GONE }, { body: 'frosio', validUntil: LIVE }], NOW);
check(lapsedList.length === 1 && /CSWIP/.test(lapsedList[0]), 'it names the lapsed one and leaves the live one alone', JSON.stringify(lapsedList));
check(!lapsedList.join(' ').toLowerCase().includes('unavailable'),
  'and never says "unavailable" without a role, because that would be a claim nobody can check', JSON.stringify(lapsedList));
check(lapsedCerts([{ body: 'cswip', validUntil: LIVE }], NOW).length === 0, 'somebody whose certificates are all in date has nothing to say');

console.log(failures ? `\ncert availability: ${failures} FAILED` : '\ncert availability: all checks passed');
process.exitCode = failures ? 1 : 0;
