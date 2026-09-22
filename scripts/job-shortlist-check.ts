/**
 * The shortlist NARROWS — it does not return most of the board with extra steps.
 *
 *   npx tsx scripts/job-shortlist-check.ts
 *
 * Pure: no database, no network, no model call. In the release gate.
 *
 * WHAT IS AT STAKE. The comparison this feeds is claude-sonnet-5 at EUR 0.01535 and 12.8 s a job,
 * measured with a real call on 2026-09-22 — EUR 3.75 to score one dropped CV against every open lead
 * and posting, nearly twice the whole daily cap. A pre-filter that quietly keeps everything does not
 * fail loudly; it just spends the day's budget on the first CV of the morning. So the assertions here
 * are about what is DROPPED, and the fixture is built so that a filter returning everything fails.
 *
 * The board below is twelve postings. A Romanian welder with a confirmed CSWIP should survive exactly
 * four of them, and each of the other eight is excluded for a different, nameable reason.
 */
import { shortlistJobs, candidateTrades, jobTrades, type ShortlistJob, type ShortlistCandidate } from '../src/lib/job-shortlist';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

/** A Romanian welder: EU passport, no UK right to work, one CONFIRMED CSWIP (which covers NDT). */
const welder: ShortlistCandidate = {
  trade: 'welder',
  certificates: [
    { body: 'cswip', certState: 'verified_register', validUntil: '2028-01-17' },
    { body: 'frosio', certState: 'pending_issuer', validUntil: '2029-01-01' },   // NOT confirmed
  ],
  rightToWork: { nationality: 'RO', eu_passport: true, uk_right_to_work: false },
};

const BOARD: ShortlistJob[] = [
  { id: 'welder-dk', trades: ['welder'], country: 'DK', role: 'Welder', postedAt: '2026-09-20' },
  { id: 'welder-no', trades: ['welder'], country: 'NO', role: 'Welder 6G', postedAt: '2026-09-18' },
  { id: 'ndt-nl', trades: ['ndt'], country: 'NL', role: 'NDT technician', postedAt: '2026-09-15' },
  { id: 'unreadable-de', trades: [], country: 'DE', role: 'Fachkraft gesucht', postedAt: '2026-09-10' },
  { id: 'scaffolder-dk', trades: ['scaffolder'], country: 'DK', role: 'Scaffolder', postedAt: '2026-09-19' },
  { id: 'electrician-no', trades: ['electrician'], country: 'NO', role: 'Electrician', postedAt: '2026-09-19' },
  { id: 'painter-se', trades: ['painter'], country: 'SE', role: 'Industrial painter', postedAt: '2026-09-17' },
  { id: 'rope-dk', trades: ['rope access'], country: 'DK', role: 'Rope access technician', postedAt: '2026-09-16' },
  { id: 'welder-uk', trades: ['welder'], country: 'GB', role: 'Welder', postedAt: '2026-09-21' },
  { id: 'welder-us', trades: ['welder'], country: 'US', role: 'Welder', postedAt: '2026-09-21' },
  { id: 'welder-sg', trades: ['welder'], country: 'SG', role: 'Welder', postedAt: '2026-09-21' },
  { id: 'wind-dk', trades: ['wind technician'], country: 'DK', role: 'Wind turbine technician', postedAt: '2026-09-14' },
];

console.log('--- what the candidate can cover ---');
const mine = candidateTrades(welder);
check(mine.trades.includes('welder'), 'their stated trade counts', JSON.stringify(mine.trades));
check(mine.trades.includes('ndt'), 'and a CONFIRMED CSWIP adds the trades that scheme implies', mine.why.join('; '));
const unconfirmedOnly = candidateTrades({ trade: 'welder', certificates: [{ body: 'frosio', certState: 'pending_issuer' }] });
check(!unconfirmedOnly.trades.includes('painter') && !unconfirmedOnly.trades.includes('blaster'),
  'an UNCONFIRMED certificate widens nothing — only a register answer does', JSON.stringify(unconfirmedOnly.trades));

console.log('\n--- what a job asks for ---');
check(jobTrades(BOARD[0]).includes('welder'), 'a stored trade is read');
check(jobTrades({ id: 'x', trades: [], role: 'Scaffolder wanted for shutdown' }).includes('scaffolder'),
  'and where the crawl stored none, the advert\'s own words are', JSON.stringify(jobTrades({ id: 'x', trades: [], role: 'Scaffolder wanted for shutdown' })));
check(jobTrades({ id: 'x', trades: ['welder'], role: 'Scaffolder' }).join() === 'welder',
  'a stored trade WINS over the words — the pipeline already decided', JSON.stringify(jobTrades({ id: 'x', trades: ['welder'], role: 'Scaffolder' })));

console.log('\n--- the shortlist narrows, and says why it dropped each one ---');
const r = shortlistJobs(welder, BOARD);
const kept = r.keep.map((k) => k.job.id).sort();
check(kept.length === 4, 'four of twelve survive — it is a filter, not a pass-through', `${kept.length}: ${kept.join(', ')}`);
check(JSON.stringify(kept) === JSON.stringify(['ndt-nl', 'unreadable-de', 'welder-dk', 'welder-no']),
  'and they are exactly the four expected', kept.join(', '));

const why = (id: string) => r.dropped.find((d) => d.id === id)?.why ?? '(not dropped)';
check(/wants scaffolder/.test(why('scaffolder-dk')), 'a scaffolding job is dropped on trade, and names both sides', why('scaffolder-dk'));
check(/wants electrician/.test(why('electrician-no')), 'so is an electrician job', why('electrician-no'));
check(/wants painter/.test(why('painter-se')), 'and a painter job — the CSWIP does not make them a painter', why('painter-se'));
check(/wants rope access/.test(why('rope-dk')), 'and rope access', why('rope-dk'));
check(/wants wind technician/.test(why('wind-dk')), 'and a wind technician job', why('wind-dk'));
check(/right to work/i.test(why('welder-uk')), 'a UK welding job is dropped on right to work, not trade', why('welder-uk'));
check(/outside Europe/.test(why('welder-us')) && /outside Europe/.test(why('welder-sg')),
  'and work outside Europe is dropped before anything is spent on it', why('welder-us'));
check(r.dropped.length === 8, 'every job that did not survive is accounted for', `${r.dropped.length} dropped, ${kept.length} kept, ${BOARD.length} in`);

console.log('\n--- an advert nobody can read is kept, not hidden ---');
const unreadable = r.keep.find((k) => k.job.id === 'unreadable-de');
check(!!unreadable, 'a posting with no readable trade survives');
check(/kept rather than hidden/.test(unreadable?.why ?? ''), 'and says that is why, so it is visible rather than quietly promoted', unreadable?.why ?? '');

console.log('\n--- the limit is a limit, and it is reported ---');
const many: ShortlistJob[] = Array.from({ length: 30 }, (_, i) => ({ id: `w${i}`, trades: ['welder'], country: 'DK', postedAt: `2026-09-${String((i % 28) + 1).padStart(2, '0')}` }));
const capped = shortlistJobs(welder, many, 12);
check(capped.keep.length === 12, 'a shortlist stops at its limit', `${capped.keep.length} kept`);
check(capped.dropped.filter((d) => /past the shortlist limit/.test(d.why)).length === 18,
  'and everything past it is reported, never silently cut', `${capped.dropped.length} dropped`);
check(String(capped.keep[0].job.postedAt) > String(capped.keep[11].job.postedAt), 'the newest adverts are the ones kept');

console.log('\n--- a candidate we know nothing about ---');
const blank = shortlistJobs({}, BOARD);
check(blank.keep.length === 1 && blank.keep[0].job.id === 'unreadable-de',
  'somebody with no trade and no certificates matches only the advert that states no trade', JSON.stringify(blank.keep.map((k) => k.job.id)));
check(blank.keep.length < BOARD.length, 'and is emphatically not shortlisted for everything');

console.log(failures ? `\njob shortlist: ${failures} FAILED` : '\njob shortlist: all checks passed');
process.exitCode = failures ? 1 : 0;
