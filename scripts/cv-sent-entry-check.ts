/**
 * A CV-sent entry never shows a date it does not have (src/lib/cv-sent-entry.ts). No database, no network.
 *
 *   npx tsx scripts/cv-sent-entry-check.ts
 *
 * Candidate #9's McDermott row — a pack prepared for a lead, sent_at null — read "01/01/1970" on production and matched
 * "sent to mcdermott". These are that row and its neighbours.
 */
import { sendKind, sendDateLabel, sendSearchText } from '../src/lib/cv-sent-entry';

let failed = 0;
const check = (ok: boolean, name: string, got?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

const logged = '2026-09-12T12:00:00Z';
check(sendKind(logged) === 'sent', 'a row with a real sent_at is a CV sent', sendKind(logged));
check(sendDateLabel(logged) === new Date(logged).toLocaleDateString('en-GB'), 'a real sent_at shows its date', sendDateLabel(logged));
check(sendSearchText('Semco Maritime', logged) === 'sent to Semco Maritime', 'a CV sent searches as "sent to"', sendSearchText('Semco Maritime', logged));

for (const [what, v] of [['null', null], ['undefined', undefined], ['empty', ''], ['epoch', '1970-01-01T00:00:00Z'], ['epoch as a number string', '0'], ['garbage', 'not a date']] as const) {
  check(sendKind(v) === 'prepared', `sent_at ${what} is not a CV sent`, sendKind(v));
  check(sendDateLabel(v) === 'date not recorded', `sent_at ${what} shows "date not recorded", never 01/01/1970`, sendDateLabel(v));
  check(!/1970/.test(sendDateLabel(v)), `sent_at ${what} never renders 1970`, sendDateLabel(v));
}
check(sendSearchText('McDermott', null) === 'pack for McDermott', 'a prepared pack searches as "pack for", not "sent to"', sendSearchText('McDermott', null));

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\ncv-sent-entry: all checks passed');
