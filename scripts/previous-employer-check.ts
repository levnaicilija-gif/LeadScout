/**
 * Item 11 part 1: the "worked for this employer before" rule, held to the cases that matter.
 *
 * Pure — no database, no model, no network. In the release gate.
 *
 *   npx tsx scripts/previous-employer-check.ts
 */
import { previousEmployer } from '../src/lib/previous-employer';
import { canonCompany } from '../src/lib/company-identity';

let failed = 0;
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const cv = (...projects: { employer?: string; years?: string }[]) => ({ projects });

/* ---------------------------------------------------- it matches what it should */
const vard = previousEmployer(
  cv({ employer: 'SC Vard Brăila SA', years: 'July 2015 – April 2017' }, { employer: 'Saver Saldature', years: '2017-2020' }),
  { name: 'VARD Braila', domain: 'vard.com' },
);
check(!!vard, 'a CV employer matches the lead company once legal form and accents are stripped', vard?.headline.why);
check(vard?.label.startsWith('Worked for this employer before') === true,
  'the badge speaks about the employer, never the site', vard?.label);
check(vard?.tone === 'ok' && vard?.headline.years === 'July 2015 – April 2017',
  'a finished employment reads as past, with the years exactly as the CV prints them', `${vard?.tone} · ${vard?.headline.years}`);
check(/How did that end/.test(vard?.question ?? ''), 'a past employer earns the rehire question', vard?.question);

/* ------------------------------------------------ it does not match what it should not */
const hitachi = previousEmployer(
  cv({ employer: 'Hitachi Energy Norway', years: '2021-2023' }),
  { name: 'Hitachi Energy Denmark', domain: 'hitachienergy.com' },
);
check(hitachi === null, 'two national arms of one brand are not the same employer');

const shell = previousEmployer(cv({ employer: 'Shell Energy', years: '2019' }), { name: 'Shell' });
check(shell === null, 'a descriptive word is not noise: Shell Energy is not Shell');

check(previousEmployer(cv({ employer: 'Esbjerg Shipyard', years: '2024' }), { name: 'Aker Solutions' }) === null,
  'an unrelated employer does not match');
check(previousEmployer(cv({ years: '2024', employer: '' }), { name: 'Aker Solutions' }) === null,
  'a CV project with no employer matches nothing');
check(previousEmployer(cv({ employer: 'Aker Solutions', years: '2024' }), { name: '' }) === null,
  'a company with no usable name matches nobody');
check(previousEmployer(null, { name: 'Aker Solutions' }) === null, 'a candidate with no CV reading matches nothing');

/* ------------------------------------------- the extra legal forms, and what they must not eat */
// SC and SRL are stripped here because canonCompany does not know them. The first cut used a bare
// word list and took the brand with it: "SC Johnson" became "johnson" and would have matched any
// company called Johnson, while "Zoo Hannover", "Sia Abrasives" and "SPA Group" each lost their
// first word. The check passed all 15 of its assertions while that was true, so these are the
// assertions it was missing.
check(previousEmployer(cv({ employer: 'SC Vard Brăila SA', years: '2015-2017' }), { name: 'VARD Braila' }) !== null,
  'the Romanian SC prefix does not stop a real match');
check(previousEmployer(cv({ employer: 'Saver Saldature', years: '2017-2020' }), { name: 'Saver Saldature SRL' }) !== null,
  'SRL on the company row does not stop a real match — the strip runs on both names');
check(previousEmployer(cv({ employer: 'SC Johnson', years: '2019' }), { name: 'Johnson' }) === null,
  'SC Johnson is not Johnson — a brand beginning with SC keeps its name');
check(previousEmployer(cv({ employer: 'Zoo Hannover', years: '2019' }), { name: 'Hannover' }) === null,
  'Zoo Hannover is not Hannover');
check(previousEmployer(cv({ employer: 'Sia Abrasives', years: '2019' }), { name: 'Abrasives' }) === null,
  'Sia Abrasives is not Abrasives');
// Not this rule's doing, and deliberately not papered over here: canonCompany itself returns
// "group" for "SPA Group", because s.p.a. is in its shared legal-form list. Any company whose name
// starts with SPA loses its brand before previousEmployer sees it — which affects findOrCreateCompany
// across every company row, not just this badge. Recorded as the shared behaviour it is, and
// reported to the owner (2026-09-16) alongside the SC/SRL gap rather than fixed locally.
check(canonCompany('SPA Group') === 'group',
  'KNOWN, shared: canonCompany drops a leading SPA as a legal form, brand and all',
  `canonCompany("SPA Group") = "${canonCompany('SPA Group')}"`);
check(previousEmployer(cv({ employer: 'Scania', years: '2019' }), { name: 'ania' }) === null,
  'a name beginning with the letters sc is not stripped mid-word');

/* ------------------------------------------------------------- current employment */
const openEnded = previousEmployer(
  cv({ employer: 'Aker Solutions AS', years: 'March 2024 – present' }),
  { name: 'Aker Solutions' },
);
check(openEnded?.tone === 'warn', 'an employment the CV leaves open reads as current', openEnded?.label);
check(/notice period|non-compete/i.test(openEnded?.question ?? ''),
  'a current employer earns the notice-period question instead', openEnded?.question);

const byField = previousEmployer(
  cv({ employer: 'Aker Solutions AS', years: '2020-2023' }),
  { name: 'Aker Solutions' },
  'Aker Solutions AS',
);
check(byField?.tone === 'warn', 'current_employer from a contract makes it current even when the years look closed', byField?.label);

/* ------------------------------------------------------------ several employments */
const twice = previousEmployer(
  cv({ employer: 'Aker Solutions', years: '2015-2017' }, { employer: 'Aker Solutions AS', years: '2022 – present' }),
  { name: 'Aker Solutions' },
);
check(twice?.matches.length === 2, 'every matching employment is kept', `${twice?.matches.length}`);
check(twice?.headline.current === true, 'a current employment is the one the card leads with', twice?.headline.years);

console.log(failed ? `\nprevious-employer check: ${failed} FAILED` : '\nprevious-employer check: all checks passed');
process.exit(failed ? 1 : 0);
