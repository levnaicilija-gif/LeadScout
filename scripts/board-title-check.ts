/**
 * A job id is never a title, a company's own Workable host is a Workable board, and a guess from a name says so —
 * proved offline.
 *
 *   npx tsx scripts/board-title-check.ts
 */
import { detectAts, atsListUrl } from '../src/lib/ats';
import { cleanTitle, needsPageTitle } from '../src/lib/job-title';
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

console.log(failed ? `board and title check: ${failed} failed` : 'board and title check: all passed');
process.exitCode = failed ? 1 : 0;
