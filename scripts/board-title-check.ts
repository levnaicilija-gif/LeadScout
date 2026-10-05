/**
 * A job id is never a title, a company's own Workable host is a Workable board, and a guess from a name says so —
 * proved offline.
 *
 *   npx tsx scripts/board-title-check.ts
 */
import { detectAts, atsListUrl } from '../src/lib/ats';
import { cleanTitle, needsPageTitle, stripFurniture } from '../src/lib/job-title';
import { detectEmployerType } from '../src/lib/agency-detector';

let failed = 0;
const check = (ok: boolean, what: string, detail?: unknown) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${what}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

// Boards
const dof = detectAts('https://dof.workable.com/jobs/1924855');
check(dof?.type === 'workable' && dof.slug === 'dof', 'dof.workable.com/jobs/1924855 is DOF\'s Workable board', dof);
check(atsListUrl('workable', 'dof') === 'https://apply.workable.com/api/v1/widget/accounts/dof?details=true', 'and it is read from Workable\'s published list');
const apply = detectAts('<a href="https://apply.workable.com/acme-offshore/j/ABC123">');
check(apply?.type === 'workable' && apply.slug === 'acme-offshore', 'apply.workable.com/<company> still works', apply);
check(detectAts('https://www.workable.com/pricing') === null, 'Workable\'s own site is not a company board');
check(detectAts('https://apply.workable.com/api/v1/widget') === null, 'Workable\'s API path is not a company either');

// Titles
check(cleanTitle('1924855') === null, 'a job id is not a title');
check(cleanTitle('REQ-20931') === null, 'nor is a requisition code');
check(needsPageTitle('1924855', 'DOF'), 'a job id sends the crawl to the posting page for the title');
check(cleanTitle('Serviceelektriker') === 'Serviceelektriker', 'one real word is still a title');
check(cleanTitle('Vacature windturbine monteur in Zeeland') === 'Vacature windturbine monteur in Zeeland', 'a title that starts with "Vacature" is still a title');
check(cleanTitle('Lead Welder 3G/4G') === 'Lead Welder 3G/4G', 'a title with codes in it is still a title');
check(cleanTitle('Read more') === null, 'a button is still not a title');

// Navigation with a verb in front of it. "Browse job offers" was a real stored role on the real
// board and reached the job shortlist; the rest are the phrasings the same link takes elsewhere.
check(cleanTitle('Browse job offers') === null, 'and neither is "Browse job offers" — the row that started this');
check(cleanTitle('Search jobs') === null, 'nor "Search jobs"');
check(cleanTitle('See all vacancies') === null, 'nor "See all vacancies"');
check(cleanTitle('Se alle stillinger') === null, 'nor the Norwegian one');
check(cleanTitle('Bekijk alle vacatures') === null, 'nor the Dutch one (BUTTON already held the bare "Bekijk vacatures" — this is the phrasing only NAV catches)');
check(cleanTitle('View open positions') === null, 'nor "View open positions"');
// The rule has to be narrow, or it eats real titles: the noun must be the generic word for work.
check(cleanTitle('Find welders') === 'Find welders', 'a title asking for a TRADE survives the same verb');
check(cleanTitle('Search engineer') === 'Search engineer', 'and so does a role whose name begins with one');
check(cleanTitle('Browse Industries Technician') === 'Browse Industries Technician', 'a verb followed by anything but the generic noun is still a title');

// Name guesses say what they are
const guess = detectEmployerType('EnBW Offshore Wind Norway');
check(guess.employerType === 'epc_contractor' && /offshore/.test(guess.reason), 'a name with "offshore" in it is guessed a contractor — and the reason says it came from the name', guess);
check(detectEmployerType('DOF').employerType === 'unknown', 'DOF\'s name says nothing, so its EPC type cannot have come from the name');

// ---- ITEM 46(b): SCRAPE RESIDUE, every rule with both arms -------------------------------------------
// All three strings below are REAL titles that reached Hiring now in item 32's re-read on 2026-10-05, and
// each rule is asserted twice: the residue is removed or refused, AND the legitimate near-neighbour that
// must survive it is kept. A rule here can only take real titles away, so the second arm is the point.

// 1. A trailing instruction, which BUTTON and NAV both miss because both are anchored to the whole string.
check(stripFurniture('Gerüstbauer (m/w/d) mehr erfahren') === 'Gerüstbauer (m/w/d)',
  'a trailing "mehr erfahren" is stripped, leaving the real title', stripFurniture('Gerüstbauer (m/w/d) mehr erfahren'));
check(stripFurniture('Gerüstbau Kolonnenführer (m/w/d) mehr erfahren') === 'Gerüstbau Kolonnenführer (m/w/d)',
  'and the same on its sibling row', stripFurniture('Gerüstbau Kolonnenführer (m/w/d) mehr erfahren'));
check(stripFurniture('Scaffolder read more') === 'Scaffolder', 'the English form too', stripFurniture('Scaffolder read more'));
// THE OTHER ARM: a separator is required, so a title whose last word happens to be one of these is untouched.
check(stripFurniture('Open position') === 'Open position',
  'a title that IS the phrase is left to BUTTON, not half-eaten here', stripFurniture('Open position'));
check(cleanTitle('Open position') === null, 'and BUTTON still refuses it whole');
check(stripFurniture('Monteur binnendienst staalkabels') === 'Monteur binnendienst staalkabels',
  'an ordinary title is untouched', stripFurniture('Monteur binnendienst staalkabels'));

// 2. A publication line scraped into the title (Aventa).
const aventa = 'SITE HSE MANAGER Published on September 18, 2026 Netherlands Freelance Based on experience';
check(stripFurniture(aventa) === 'SITE HSE MANAGER', 'everything from "Published on" onward is the site\'s metadata', stripFurniture(aventa));
check(stripFurniture('Welder posted on 2026-09-01') === 'Welder', '"posted on" is the same cue', stripFurniture('Welder posted on 2026-09-01'));
// THE OTHER ARM: "on" alone is an ordinary English word in a real title and must not trigger anything.
check(stripFurniture('Technician based on Teesside') === 'Technician based on Teesside',
  'a bare "on" in a real title survives', stripFurniture('Technician based on Teesside'));
check(stripFurniture('Rope access technician on shutdowns') === 'Rope access technician on shutdowns',
  'and so does "on" after a trade', stripFurniture('Rope access technician on shutdowns'));

// 3. A section heading glued to the title (Fugro). NOT stripped — there is no way to know where the real
// title begins — so the POSTING PAGE is asked. The exemption for a name prefix is what used to hide it.
check(needsPageTitle('ProjectsProject ManagerUnited Kingdom', 'Fugro'),
  'a glued section heading sends the crawl to the posting page');
check(needsPageTitle('automatikerHandling'), 'a lowercase word glued to a capitalised one still does');
// AND THE LIMIT, ASSERTED SO NOBODY RE-DISCOVERS IT: a glued pair whose first fragment is short is
// indistinguishable from a name prefix ("Vats" and "Van" are the same shape), so it is NOT caught. This
// file's comment used to claim otherwise. Asserting the real behaviour keeps the claim honest.
check(!needsPageTitle('VatsVindafjord'), 'a SHORT capitalised glued pair is not caught — it looks exactly like VanOord');
// THE OTHER ARM, AND THE REASON THE EXEMPTION EXISTS: a real name carrying an inner capital is NOT mangled.
check(!needsPageTitle('McDermott welder', 'Acme'), 'McDermott is a name, not glued words');
check(!needsPageTitle('VanOord deckhand', 'Acme'), 'VanOord likewise');
check(!needsPageTitle('Senior ROV Pilot Technician', 'Gardline'), 'an all-caps acronym in a real title is fine');
check(!needsPageTitle('CNC-Bohrwerkdreher/Polymechaniker 100% (w/m/d)', 'Burckhardt Compression'),
  'a German compound with a slash is a real title');

console.log(failed ? `board and title check: ${failed} failed` : 'board and title check: all passed');
process.exitCode = failed ? 1 : 0;
