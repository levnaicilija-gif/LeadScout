/**
 * Hiring now's Decision-maker cell: the right source wins, and an empty cell says WHICH absence it is.
 * Pure — no network, no model, no database: npx tsx scripts/decision-maker-check.ts
 *
 * The precedence is the owner's, 2026-09-29: a named person on the COMPANY, then a named person on the
 * ADVERT, then the general phone, then the general email, then the honest absence. Every rule carries
 * both arms, because the failure that matters is silent: a cell that falls through to a weaker source
 * while a better one is on file looks exactly like a cell with nothing to show.
 */
import { decisionMaker } from '../src/lib/decision-maker';

let failed = 0;
const check = (ok: boolean, what: string, got?: unknown) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` — ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

const person = { name: 'René Hansen', title: 'Production Manager', phone: '+45 26 87 44 33', email: null };
const advert = { name: 'Stephen Bjorheim', title: null, email: 'sb@example.test' };
const co = { domain: 'example.test', contacts_checked_at: '2026-09-29T00:00:00Z', switchboard: '+45 98 92 28 88', general_email: 'info@example.test' };

// ---- THE ORDER, each step proved to WIN over the one below it ---------------------------------------
const all = decisionMaker({ people: [person], advert, company: co });
check(all.kind === 'person' && all.from === 'company' && all.name === 'René Hansen', 'a named person on the COMPANY wins over everything else', all);
check(all.kind === 'person' && /Production Manager/.test(all.detail) && /phone found/.test(all.detail), 'and the cell says their title and that a phone was found', all);

const noPerson = decisionMaker({ people: [], advert, company: co });
check(noPerson.kind === 'person' && noPerson.from === 'advert' && noPerson.name === 'Stephen Bjorheim', "the ADVERT's contact wins when the company has nobody", noPerson);
check(noPerson.kind === 'person' && /from the advert/.test(noPerson.detail), 'and the cell says it came from the advert, not from their site', noPerson);
check(noPerson.kind === 'person' && /title not printed/.test(noPerson.detail), 'a contact with no title says so rather than showing a blank', noPerson);

const general = decisionMaker({ people: null, advert: null, company: co });
check(general.kind === 'general' && general.what === 'switchboard', 'the SWITCHBOARD wins when nobody is named', general);
const emailOnly = decisionMaker({ people: null, advert: null, company: { ...co, switchboard: null } });
check(emailOnly.kind === 'general' && emailOnly.what === 'general email' && emailOnly.value === 'info@example.test', 'the GENERAL EMAIL is used when there is no phone', emailOnly);

// ---- NEVER BLANK WHILE ANYTHING IS KNOWN ------------------------------------------------------------
// A person with an empty name is not a person: the row exists but names nobody, and falling through to
// the switchboard is the honest answer rather than rendering an empty bold line.
check(decisionMaker({ people: [{ name: '   ', title: 'Manager' }], company: co }).kind === 'general',
  'a contact row whose name is blank does not win the cell', decisionMaker({ people: [{ name: '   ' }], company: co }));
check(decisionMaker({ people: [{ name: null }, person], company: co }).kind === 'person',
  'and a real person further down the list still wins it');

// ---- THE THREE ABSENCES, which are three different actions for a recruiter --------------------------
const noSite = decisionMaker({ company: { domain: null, contacts_checked_at: null } });
check(noSite.kind === 'none' && noSite.state === 'no_website' && noSite.text === 'no website on file', 'no website on file says exactly that', noSite);
const notRead = decisionMaker({ company: { domain: 'example.test', contacts_checked_at: null } });
check(notRead.kind === 'none' && notRead.state === 'not_read' && /has not been read/.test(notRead.text), 'a site nobody has read yet says so — not "nobody found"', notRead);
const printedNothing = decisionMaker({ company: { domain: 'example.test', contacts_checked_at: '2026-09-29T00:00:00Z' } });
check(printedNothing.kind === 'none' && printedNothing.state === 'nothing_printed' && /nothing printed/.test(printedNothing.text), 'a site we read that printed nothing says THAT', printedNothing);
const said = (r: ReturnType<typeof decisionMaker>) => (r.kind === 'none' ? r.text : `(not an absence: ${r.kind})`);
check(new Set([said(noSite), said(notRead), said(printedNothing)]).size === 3,
  'the three absences are DISTINGUISHABLE — a rule returning one constant would pass any single assertion',
  [said(noSite), said(notRead), said(printedNothing)]);

// ---- AND THE CELL IS NEVER EMPTY --------------------------------------------------------------------
for (const [label, input] of [
  ['everything', { people: [person], advert, company: co }],
  ['advert only', { advert, company: { domain: null } }],
  ['switchboard only', { company: { domain: 'x.test', switchboard: '+47 1' + '2345678' } }],
  ['nothing at all', { company: null }],
] as const) {
  const r = decisionMaker(input as any);
  const shown = r.kind === 'none' ? r.text : r.kind === 'person' ? r.name : r.value;
  check(!!String(shown ?? '').trim(), `the cell always has something to show: ${label}`, r);
}

console.log(failed ? `\n${failed} failed` : '\ndecision maker: all checks passed');
process.exitCode = failed ? 1 : 0;
