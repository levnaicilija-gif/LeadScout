/**
 * The person-on-site reader, proved offline on made-up pages — no real person's details in the repo.
 *
 *   npx tsx scripts/person-on-site-check.ts
 */
import { personOnPage, addressFits, rankPages } from '../src/lib/person-on-site';

let failed = 0;
const check = (ok: boolean, what: string, detail?: unknown) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${what}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};
const page = (text: string) => ({ text, url: 'https://example-group.test/news/our-team-at-the-fair', fetchedAt: '2026-09-14T15:00:00Z' });
const team = page('Meet us at the fair. Jane Example Person, Wind Operations Manager, Energy Solutions +45 11 22 33 44 jane.person@example-group.test '
  + 'Anna Nophone, Logistics Coordinator John Sample, Logistics Director +45 55 66 77 88 john.sample@example-group.test '
  + 'Carl Private, Advisor carl.private@gmail.com');
const hosts = ['example-group.test'];

const jane = personOnPage(team, 'Jane Example Person', hosts);
check(jane?.email === 'jane.person@example-group.test' && jane.phone === '+45 11 22 33 44' && jane.title === 'Wind Operations Manager, Energy Solutions',
  'a person printed with title, number and address gets all three', jane);
check(personOnPage(team, 'John Sample', hosts)?.email === 'john.sample@example-group.test', 'the next person gets their own address');
check(personOnPage(team, 'Anna Nophone', hosts) === null, 'a person printed with no address of their own takes nothing — not the next person\'s address or number');
check(personOnPage(team, 'Carl Private', hosts) === null, 'an address off the company\'s domain is not taken');
check(personOnPage(team, 'Someone Absent', hosts) === null, 'a name not on the page finds nothing');
// As norsea.dk's Hamburg page reads once its markup is stripped: no space between the number and the address.
const glued = personOnPage(page('Jane Example Person, Wind Operations Manager+45 11 22 33 44jane.person@example-group.test Next Person'), 'Jane Example Person', hosts);
check(glued?.email === 'jane.person@example-group.test' && glued.phone === '+45 11 22 33 44',
  'digits glued to the front of an address go back to the number, and the address is the real one', glued);
check(personOnPage(page('jane example person, Operations +45 11 22 33 44 jane.person@example-group.test'), 'Jane Example Person', hosts)?.email === 'jane.person@example-group.test', 'the name is found whatever its case');
check(personOnPage(page('Jane Example Person jane.person@mail.example-group.test'), 'Jane Example Person', hosts)?.email === 'jane.person@mail.example-group.test', 'a subdomain of the company\'s domain counts');
check(personOnPage(page('Jane Example Person, Manager +45 11 22 33 44 jane.person@example-group.test'), 'Jane', hosts) === null, 'a single name is never enough');

check(addressFits('c.d.christensen', 'Christian Drechsler Christensen'), 'initials and surname fit');
check(addressFits('klaus.grau', 'Klaus Iversen Grau'), 'first name and surname fit');
check(!addressFits('kim.list', 'Klaus Iversen Grau'), 'another person\'s address does not fit');
check(addressFits('rene.hansen', 'René Hansen'), 'accents in the name do not stop a fit');

const ranked = rankPages([
  'https://example-group.test/products/crane', 'https://example-group.test/news-and-events/wind-europe-2025/',
  'https://example-group.test/about', 'https://example-group.test/files/brochure.pdf', 'https://example-group.test/people/jane-person',
], ['Jane Example Person'], 3);
check(ranked[0] === 'https://example-group.test/people/jane-person' && ranked[1].includes('wind-europe') && !ranked.some((u) => u.endsWith('.pdf')) && !ranked.some((u) => u.includes('products')),
  'a page with the surname in its address comes first, then an event page; files and product pages are never read', ranked);

console.log(failed ? `person-on-site check: ${failed} failed` : 'person-on-site check: all passed');
process.exit(failed ? 1 : 0);
