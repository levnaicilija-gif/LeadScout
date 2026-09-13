/**
 * Pins what counts as an observed email pattern. No database, no network. The fragments are the
 * real shapes found in stored articles on 2026-09-13.
 *
 *   npx tsx scripts/email-pattern-check.ts
 *
 * Exits 1 on any failure.
 */
import { observePatterns, confidenceOf } from '../src/lib/email-pattern';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const at = '2026-09-13T12:00:00Z';
const obs = (text: string, name: string, domain: string | null) => observePatterns({ text, url: 'https://example.invalid/a', readAt: at }, { name, domain });

const mcd = obs('Media contact Reba Reid +1 832 513 1068 RReid@McDermott.comMedia contact Treasurer Kevin Leader treasurerkevin.leader@mcdermott.com Investor relations 5636rreid@mcdermott.com', 'McDermott', 'mcdermott.com');
check(mcd.some((o) => o.pattern === 'flast' && o.corroborated && o.name === 'Reba Reid'), 'RReid@ beside "Reba Reid" is flast, corroborated, though the domain ran into the next word', JSON.stringify(mcd.map((o) => [o.address, o.pattern, o.corroborated])));
check(mcd.some((o) => o.pattern === 'first.last' && o.corroborated && o.address === 'kevin.leader@mcdermott.com'), '"treasurerkevin.leader" beside "Kevin Leader" is recovered as first.last');
check(!mcd.some((o) => o.address.startsWith('5636')), 'an address starting with digits is not a pattern');

const vf = obs('Magnus Kryssare, Press Officer, magnus.kryssare@vattenfall.com. Johan Sennerö johan.senneroe@vattenfall.com. Emmi Östlund emmi.ostlund@vatttenfall.com', 'VATTENFALL', 'vattenfall.com');
check(vf.filter((o) => o.pattern === 'first.last' && o.corroborated).length === 2, 'Kryssare and Sennerö (written "oe") both corroborate first.last', JSON.stringify(vf.map((o) => [o.address, o.pattern, o.corroborated])));
check(!vf.some((o) => o.address.includes('ostlund')), 'a typo domain (vatttenfall.com) is not the company\'s own');
check(confidenceOf(2, 2) === 'high', 'two corroborated addresses give high confidence');

const saipem = obs('Beware of fraudulent emails claiming to come from name.surname@saipem.com or saipem.recruit@gmail.com.', 'Saipem', 'saipem.com');
check(saipem.length === 0, 'addresses on a fraud warning are not observations', JSON.stringify(saipem));

const eq = obs('Contact Magnus Frantzen Eidsvold mfei@equinor.com', 'Equinor', 'equinor.com');
check(eq.length === 0, 'an initials-only local part that no name produces is left unclassified', JSON.stringify(eq));

const role = obs('For media enquiries write to press@aibel.com.', 'AIBEL', 'aibel.com');
check(role.length === 1 && role[0].pattern === 'role', 'a press mailbox is recorded as a role address, not a person pattern');

const other = obs('Olsen said, contact jantje.bolduan@ewe.de for EWE.', 'DWT (Deutsche Windtechnik)', 'deutsche-windtechnik.de');
check(other.length === 0, 'an address on another company\'s domain does not count for this company');

const noDomain = obs('Tim Burnham tim.burnham@worley.com', 'Worley', null);
check(noDomain.length === 1 && noDomain[0].domain === 'worley.com' && noDomain[0].corroborated, 'with no domain on file, an address whose domain spells the company name counts', JSON.stringify(noDomain));

// Real stored shapes that the first backfill missed or got wrong, 2026-09-13.
const glued = obs('forward-looking statement.Contacts:Global Media RelationsReba Reid+1 281 588 5636 RReid@McDermott.com', 'McDermott', null);
check(glued.some((o) => o.pattern === 'flast' && o.corroborated && o.name === 'Reba Reid'), 'a name glued to the label before it ("RelationsReba Reid") still corroborates RReid@', JSON.stringify(glued.map((o) => [o.address, o.pattern, o.corroborated, o.name])));
const parent = obs('For more information, please contact: Vattenfall’s Press Office, +46 8 739 50 10, press@vattenfall.com', 'VATTENFALL', 'group.vattenfall.com');
check(parent.length === 1 && parent[0].pattern === 'role' && parent[0].domain === 'vattenfall.com', 'an address on the parent of the company\'s domain (vattenfall.com for group.vattenfall.com) counts', JSON.stringify(parent));
const dredging = obs('Boskalis Dredging Division, contact dredging@boskalis.com for tenders.', 'Boskalis', 'boskalis.com');
check(!dredging.some((o) => o.corroborated), '"dredging@" beside "Boskalis Dredging Division" is not a person\'s first name', JSON.stringify(dredging.map((o) => [o.address, o.pattern, o.corroborated])));

console.log(failures === 0 ? '\nemail patterns: all checks passed' : `\nemail patterns: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
