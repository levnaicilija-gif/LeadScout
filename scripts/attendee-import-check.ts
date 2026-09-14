/**
 * The attendee import plan and the attendee matcher, proved offline — no database, so no probe rows.
 *
 *   npx tsx scripts/attendee-import-check.ts
 */
import { planImport, personKey, type ExistingPerson } from '../src/lib/attendee-import';
import { attendeeMatch } from '../src/lib/attendee-match';

let failed = 0;
const check = (ok: boolean, what: string, detail?: unknown) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${what}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};
const CPH = 'WindEurope Copenhagen attendee list';
const MAD = 'WindEurope Annual Event 2026';
const NOW = '2026-09-14T15:00:00Z';

const existing: ExistingPerson[] = [
  { id: 'p1', name: 'Kari Nordmann', company_name: 'AIBEL AS', title: 'Resource Coordinator', country: 'Norway', source: CPH, ops_relevant: true, seen_at_events: [CPH], title_history: [] },
  { id: 'p2', name: 'Ole Hansen', company_name: 'DOF Denmark', title: 'Crewing Manager', country: 'Denmark', source: CPH, seen_at_events: [CPH], title_history: [] },
  // A row from before 0030's backfill: seen_at_events empty, so the source stands in for it.
  { id: 'p3', name: 'Anna Berg', company_name: 'Vestas Wind Systems A/S', title: 'Site Manager', country: null, source: CPH, seen_at_events: [], title_history: [] },
];
const plan = planImport(existing, [
  { name: 'kari  nordmann', company_name: 'AIBEL', title: 'Resource Coordinator', country: 'Norway' },
  { name: 'Ole Hansen', company_name: 'DOF BirdLife Denmark', title: 'Volunteer', country: 'Denmark' },
  { name: 'Anna Berg', company_name: 'Vestas Wind Systems A/S', title: 'Construction Manager', country: 'Denmark' },
  { name: 'Anna Berg', company_name: 'Vestas Wind Systems A/S', title: 'Construction Manager', country: 'Denmark' },
  { name: 'New Person', company_name: 'NorSea Group AS', title: 'Operations Manager', country: 'Norway' },
  { name: ' ', company_name: 'Somewhere', title: null, country: null },
  { name: 'Kari Nordmann', company_name: 'AIBEL', title: null, country: null },
], MAD, NOW);

check(personKey('Kari  Nordmann', 'AIBEL AS') === personKey('kari nordmann', 'AIBEL'), 'the same name at "AIBEL AS" and "AIBEL" is one person');
check(plan.updates.some((u) => u.id === 'p1' && u.seen_at_events.join() === `${CPH},${MAD}` && u.title === undefined), 'a match gains the event and keeps an unchanged title', plan.updates.find((u) => u.id === 'p1'));
check(!plan.updates.some((u) => u.id === 'p2') && plan.inserts.some((i) => i.company_name === 'DOF BirdLife Denmark'), 'the same name at a different company ("DOF BirdLife Denmark", not "DOF Denmark") is a new person');
const anna = plan.updates.find((u) => u.id === 'p3');
check(!!anna && anna.title === 'Construction Manager' && anna.title_history?.[0]?.title === 'Site Manager' && anna.title_history?.[0]?.source === CPH && anna.seen_at_events.join() === `${CPH},${MAD}`,
  'a changed title takes the newer list\'s and keeps the earlier one with where it came from', anna);
check(anna?.country === 'Denmark', 'a country the row lacked is filled from the list');
check(plan.repeatedInList === 2, 'a person repeated inside the list is counted once (Anna twice more, Kari once more)', plan.repeatedInList);
check(plan.unusable === 1, 'a row with no name is not imported', plan.unusable);
check(plan.inserts.length === 2 && plan.inserts.every((i) => i.source === MAD && i.seen_at_events.join() === MAD), 'new people are tagged with the new list', plan.inserts);
check(plan.inserts.find((i) => i.name === 'New Person')?.ops_relevant === true, 'a new person\'s ops flag is read from their title');

// A rerun after the write changes nothing.
const after: ExistingPerson[] = existing.map((e) => ({ ...e, ...(plan.updates.find((u) => u.id === e.id) ?? {}) } as ExistingPerson))
  .concat(plan.inserts.map((i, n) => ({ id: `new${n}`, ...i, title_history: [] })));
const again = planImport(after, [
  { name: 'Kari Nordmann', company_name: 'AIBEL', title: 'Resource Coordinator', country: 'Norway' },
  { name: 'Anna Berg', company_name: 'Vestas Wind Systems A/S', title: 'Construction Manager', country: 'Denmark' },
  { name: 'New Person', company_name: 'NorSea Group AS', title: 'Operations Manager', country: 'Norway' },
], MAD, NOW);
check(again.inserts.length === 0 && again.updates.length === 0 && again.alreadyRecorded === 3, 'running the same list again changes nothing', again);

// The matcher behind Hiring now and Radar.
check(attendeeMatch('AF Gruppen ASA', 'Pan African University for Water and Energy Science Including Climate Change') === null, 'AF Gruppen does not take in Pan African University');
check(attendeeMatch('dg groep', 'DG Competition - European Commission') === null, 'dg groep does not take in DG Competition');
check(attendeeMatch('AIBEL', 'AIBEL AS') === 'name', 'AIBEL matches AIBEL AS by name');
check(attendeeMatch('VESTAS', 'Vestas Wind Systems A/S') === 'group', 'VESTAS takes in Vestas Wind Systems A/S as its group');
check(attendeeMatch('DOF', 'DOF BirdLife Denmark') === null, 'a short name (DOF) never groups');
check(attendeeMatch('Odfjell Drilling', 'Odfjell Oceanwind AS') === null, 'Odfjell Drilling is not Odfjell Oceanwind');
check(attendeeMatch('Jacobs', 'Simetrica-Jacobs') === null, 'Jacobs is not Simetrica-Jacobs');

console.log(failed ? `attendee import check: ${failed} failed` : 'attendee import check: all passed');
process.exit(failed ? 1 : 0);
