/**
 * Item 37: the site's OWN contact page is followed, the home page is read, and a wrong page is never
 * followed. Pure — no network, no model, no database: npx tsx scripts/contact-links-check.ts
 *
 * WHY IT EXISTS. Discovery ran on Schiffswerft Fischer GmbH alone on 2026-09-28 and returned nothing:
 * no switchboard, no email, EUR 0.00, never reaching a model. The site prints a landline on
 * /impressum, links it from the home page, and prints a mobile on the home page itself. The chain
 * guessed /contact (404 there), never followed the site's own link, and never ran the extractors over
 * the home page it was already fetching for organisationLinks.
 *
 * BOTH ARMS ON EVERY RULE, because the dangerous half of this change is what it must NOT follow: a
 * wrong contact page attributes a phone number to the wrong company, which is worse than finding none.
 */
import { contactLinks, emailsOn, phoneOn } from '../src/lib/hiring-contacts';
import { siteTrust } from '../src/lib/site-trust';

let failed = 0;
const check = (ok: boolean, what: string, got?: unknown) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` — ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

const page = (url: string, links: string[], linkTexts?: string[]) => ({ url, links, linkTexts });

// ---- 1. THE REAL CASE, in the shape the live site serves --------------------------------------------
// Taken from schiffswerft-fischer.de as read on 2026-09-28: the contact section is an ANCHOR on the home
// page, and the imprint is a real page linked from it.
const fischer = page('https://www.schiffswerft-fischer.de', [
  'https://www.schiffswerft-fischer.de/#Contact',
  'https://www.schiffswerft-fischer.de/#Kontakt',
  'https://www.schiffswerft-fischer.de/impressum/',
  'https://www.schiffswerft-fischer.de/leistungen/',
]);
const fischerLinks = contactLinks(fischer, 2);
check(fischerLinks.includes('https://www.schiffswerft-fischer.de/impressum/'), "Fischer: the site's own /impressum/ link is followed", fischerLinks);
check(!fischerLinks.some((u) => u.includes('#')), 'Fischer: a same-page #Kontakt anchor is NOT fetched — that is the home page, read directly', fischerLinks);
check(!fischerLinks.some((u) => u.includes('leistungen')), 'Fischer: an ordinary page is not mistaken for a contact page', fischerLinks);

// The numbers the live pages print. phoneOn refuses anything under 9 digits, and both of these clear it.
check(phoneOn({ text: 'Impressum Schiffswerft Fischer GmbH Telefon: 04692/20740 Telefax: 04692/20742' }) === '04692/20740',
  'the imprint\'s landline is read, separators and all', phoneOn({ text: 'Telefon: 04692/20740' }));
check(phoneOn({ text: 'Mobil 0172 4611282 | Werft' }) === '0172 4611282', 'the home page\'s mobile is read', phoneOn({ text: 'Mobil 0172 4611282' }));

// ---- 2. THE TRAP: a page whose path merely CONTAINS a contact word ---------------------------------
const optician = page('https://example.test', [
  'https://example.test/contact-lenses',
  'https://example.test/contact-lens-care',
  'https://example.test/kontaktlinsen',
]);
check(contactLinks(optician, 3).length === 0, '"contact-lenses" is NEVER followed — the match is the whole segment, not a substring', contactLinks(optician, 3));

// ---- 3. A SITE WITH NO CONTACT PAGE AT ALL must yield nothing ---------------------------------------
const bare = page('https://example.test', ['https://example.test/products', 'https://example.test/news/2026', 'https://example.test/']);
check(contactLinks(bare, 2).length === 0, 'a site that links no contact page yields no candidates', contactLinks(bare, 2));
check(phoneOn({ text: 'We build ships. Established 1923. All rights reserved.' }) === null, 'a page printing no number yields no number');
check(emailsOn({ text: 'no addresses here', url: 'https://example.test' }, 'example.test').general === null, 'a page printing no address yields no address');

// ---- 4. THE LANGUAGES WE ACTUALLY HAVE, measured: NO 221, NL 213, DK 73, DE 26, ES 10, FR 4 ---------
for (const [seg, why] of [['kontakt', 'DE/DK/NO'], ['impressum', 'DE'], ['over-ons', 'NL'], ['om-oss', 'NO/SE'],
  ['contacto', 'ES'], ['nous-contacter', 'FR'], ['contatti', 'IT'], ['o-nas', 'PL'], ['contact-us', 'GB/IE']] as const) {
  const got = contactLinks(page('https://x.test', [`https://x.test/${seg}`]), 1);
  check(got.length === 1, `/${seg} is followed (${why})`, got);
}
// A trailing slash, an extension and an underscore are the same page.
check(contactLinks(page('https://x.test', ['https://x.test/Kontakt/']), 1).length === 1, 'a trailing slash and capitals do not hide a contact page');
check(contactLinks(page('https://x.test', ['https://x.test/de/impressum.html']), 1).length === 1, 'a nested path and an .html extension do not hide one');
check(contactLinks(page('https://x.test', ['https://x.test/kontakt_os']), 1).length === 1, 'an underscore reads as a hyphen');

// ---- 5. THE TEXT ARM: a CMS slug is unreachable by path, and the anchor text is all there is --------
const cms = page('https://x.test', ['https://x.test/p/12345', 'https://x.test/p/999'], ['Kontakt oss', 'Våre skip']);
check(contactLinks(cms, 2)[0] === 'https://x.test/p/12345', 'a numeric CMS slug linked as "Kontakt oss" is followed on its TEXT', contactLinks(cms, 2));
check(contactLinks(cms, 2).length === 1, 'and its neighbour, linked as something else, is not', contactLinks(cms, 2));
check(contactLinks(page('https://x.test', ['https://x.test/p/1'], ['Contact lenses']), 2).length === 0,
  'the text arm has the same discipline: "Contact lenses" is not a contact page', contactLinks(page('https://x.test', ['https://x.test/p/1'], ['Contact lenses']), 2));

// ---- 5b. APEX vs www — THE TRAP THE FIXTURES ABOVE COULD NOT SEE (2026-09-28) ----------------------
// Every arm above uses ONE host form, so they all passed while the live site returned nothing: the real
// fetch of https://schiffswerft-fischer.de redirects to www, and all 27 of its links are www, so with the
// origin taken from the REQUESTED url every candidate was dropped and the step reported "no contact
// links" — indistinguishable from a site that links none. Both directions are asserted, because a fix
// that only handled apex→www would leave the mirror image broken.
const apexReq = { url: 'https://fischer.test', finalUrl: 'https://www.fischer.test/', links: ['https://www.fischer.test/impressum/'] };
check(contactLinks(apexReq, 2).length === 1, 'requested at the apex, links written as www: the link is still followed', contactLinks(apexReq, 2));
const wwwReq = { url: 'https://www.fischer.test', finalUrl: 'https://fischer.test/', links: ['https://fischer.test/kontakt'] };
check(contactLinks(wwwReq, 2).length === 1, 'and the mirror image — requested at www, links written at the apex', contactLinks(wwwReq, 2));
const noFinal = { url: 'https://fischer.test', links: ['https://www.fischer.test/kontakt'] };
check(contactLinks(noFinal, 2).length === 1, 'with no redirect recorded at all, apex and www are still one site', contactLinks(noFinal, 2));
// And the guard still holds: a DIFFERENT company is not reachable by adding www to it.
check(contactLinks({ url: 'https://fischer.test', finalUrl: 'https://www.fischer.test/', links: ['https://www.other.test/kontakt'] }, 2).length === 0,
  'another company is not the same site just because both carry www');

// ---- 6. NEVER LEAVE THE COMPANY'S SITE, and rank the better page first ------------------------------
check(contactLinks(page('https://x.test', ['https://other.test/kontakt']), 2).length === 0, "another company's contact page is never followed");
const both = contactLinks(page('https://x.test', ['https://x.test/impressum', 'https://x.test/kontakt']), 2);
check(both[0] === 'https://x.test/kontakt', 'a contact page outranks an imprint', both);
check(contactLinks(page('https://x.test', ['https://x.test/kontakt', 'https://x.test/impressum', 'https://x.test/about']), 2).length === 2,
  'the page budget is bounded — never more candidates than asked for');

// ---- 7. siteTrust: a hand-entered domain now says so ------------------------------------------------
const owner = siteTrust({ name: 'Schiffswerft Fischer GmbH', domain: 'schiffswerft-fischer.de', domain_source: 'owner confirmed by hand' });
check(owner?.check === 'from_owner' && owner.confirmed === true, 'an owner-confirmed domain reads as confirmed, not as silence', owner);
check(!!owner?.lines.some((l) => l.tone === 'ok' && /confirmed by hand/i.test(l.text)), 'and says so in the ok tone', owner?.lines);
check(owner?.rowNote === null, 'and the row carries no "unconfirmed" note', owner?.rowNote);
// The stronger evidence still wins, and an ordinary search domain is unchanged.
const printed = siteTrust({ name: 'X', domain: 'x.test', domain_source: 'owner confirmed by hand', domain_address_check: 'printed' });
check(printed?.check === 'printed', 'a printed address still outranks a hand entry — stronger evidence wins', printed?.check);
const search = siteTrust({ name: 'X', domain: 'x.test', domain_source: 'web search' });
check(search?.check === null && search.confirmed === false, 'a plain web-search domain is unchanged: neither confirmed nor unconfirmed', search);

console.log(failed ? `\n${failed} failed` : '\ncontact links: all checks passed');
process.exitCode = failed ? 1 : 0;
