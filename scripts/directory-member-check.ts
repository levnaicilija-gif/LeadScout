/**
 * The member-directory import's two judgements, held to the rows they actually produced.
 *
 *   npx tsx scripts/directory-member-check.ts
 *
 * WHAT WENT WRONG, and both cases are real rows in this database (found 2026-10-05/06):
 *   - `profile` mode took `sub.links.find(external)` — the FIRST link leaving the page — as the member's
 *     website. Norwegian Offshore Wind banners its own conference, Floating Wind Days, on every member page,
 *     so that link won for EVERY profile: nine companies with correct names and `floatingwinddays.com` as
 *     their domain. The nine were cleared by hand on 2026-10-05.
 *   - the name came from the page `<title>`'s first segment, so a NedZero membership page titled "Premium |
 *     NedZero" created a company row called "Premium" carrying another member's domain.
 *
 * BOTH ARMS ON EVERY RULE, because each one can only take real members away. A guard that refuses everything
 * passes every "this is refused" assertion, and the import's whole purpose is to find domains for free.
 */
import { looksLikeMembershipTier, pickMemberSite } from '../src/lib/directory-member';

let fail = 0;
const check = (ok: boolean, what: string, got?: unknown) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` — ${JSON.stringify(got)}`}`);
  if (!ok) fail++;
};

console.log('--- a membership tier is not a company name ---');
for (const tier of ['Premium', 'premium', 'Gold', 'Silver', 'Members', 'Membership', 'Partner', 'Sponsor',
  'Associate member', 'Full member', 'Startup', 'Home', 'Directory', 'Leden', 'Medlemmer', 'Mitglieder']) {
  check(!!looksLikeMembershipTier(tier), `"${tier}" is refused as a name`, looksLikeMembershipTier(tier));
}
// THE OTHER ARM: a real company whose name merely CONTAINS a tier word must survive. Anchored to the whole
// name, so this cannot be defeated by a company that happens to be called Premium-something.
console.log('\n--- and a real company carrying one of those words is NOT refused ---');
for (const real of ['Premium Wind Services AS', 'Gold Coast Marine', 'Partner Logistics BV', 'Associate Engineering Ltd',
  'Standard Industries', 'Pro Welding Oy', 'Enterprise Offshore', 'Platinum Scaffolding Ltd', 'Friends Shipyard']) {
  check(looksLikeMembershipTier(real) === null, `"${real}" is kept`, looksLikeMembershipTier(real));
}

console.log('\n--- which external link is the member\'s own site ---');
// 1. THE REGRESSION CASE. The conference is first in the DOM; the member's own site is second. Under the old
// `find(first external)` rule this returned floatingwinddays.com for all nine members.
let p = pickMemberSite('Logi Trans AS', ['floatingwinddays.com', 'logitrans.no']);
check(p.host === 'logitrans.no', 'the conference banner loses to the member\'s own site, however early it appears', p);
p = pickMemberSite('Olympic Subsea ASA', ['floatingwinddays.com', 'linkedin.com', 'olympic.no']);
check(p.host === 'olympic.no', 'and so do the platforms', p);

// 2. Name evidence beats position even when the wrong link is not a known directory.
p = pickMemberSite('Marine Technologies', ['some-sponsor.com', 'marinetechnologies.no']);
check(p.host === 'marinetechnologies.no', 'a host carrying the member\'s name wins over an earlier unknown host', p);

// 3. Exactly one candidate and no name match: take it. Most of these directories link only the member.
p = pickMemberSite('Vintraleå', ['vintralea-industri.no']);
check(p.host === 'vintralea-industri.no', 'a single non-directory link is accepted even without a name match', p);

// 4. SEVERAL candidates and no name match: store NOTHING. This is the arm that stops a guess.
p = pickMemberSite('Segwell', ['sponsor-one.com', 'sponsor-two.com', 'unrelated-three.com']);
check(p.host === null && /none carries/.test(p.why), 'several unrelated links and no name match stores nothing, and says why', p);

// 5. Nothing but directories: nothing stored, with a different reason.
p = pickMemberSite('KOSMOS ENERGY', ['floatingwinddays.com', 'linkedin.com', 'norwegianoffshorewind.no']);
check(p.host === null && /directory, event or platform/.test(p.why), 'a page linking only directories stores nothing', p);

// 6. No links at all.
p = pickMemberSite('Argus Remote Systems', []);
check(p.host === null, 'a profile with no external link stores nothing', p);

// 7. www and duplicates are normalised, so one host cannot look like two candidates.
p = pickMemberSite('Segwell', ['www.segwell.no', 'segwell.no']);
check(p.host === 'segwell.no', 'www. and the bare host are one candidate, not two', p);

console.log(`\ndirectory member: ${fail ? `${fail} FAILED` : 'all checks passed'}`);
process.exitCode = fail ? 1 : 0;
