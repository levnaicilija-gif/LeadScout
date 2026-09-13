/**
 * Queue item 17: the lead-age rules, at their edges. No database, no network.
 *
 *   npx tsx scripts/lead-age-check.ts
 *
 * Exits 1 on any failure.
 */
import { newsLeadAge, tenderLeadAge, postingAge, reAdverts, ageSink, daysSince } from '../src/lib/lead-age';
import { awardText, awardDateFromText, type Award } from '../src/lib/tender/award';

const NOW = new Date('2026-09-13T15:00:00Z');
const ago = (n: number) => new Date(Date.UTC(2026, 8, 13) - n * 86_400_000).toISOString().slice(0, 10);

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const is = (got: string, want: string, what: string) => check(got === want, what, got);

// News: flag at 45, stale at 90.
is(newsLeadAge({ publishedAt: ago(44) }, NOW).state, 'fresh', 'news, 44 days → fresh');
is(newsLeadAge({ publishedAt: ago(45) }, NOW).state, 'flagged', 'news, 45 days → flagged');
is(newsLeadAge({ publishedAt: ago(89) }, NOW).state, 'flagged', 'news, 89 days → flagged');
is(newsLeadAge({ publishedAt: ago(90) }, NOW).state, 'stale', 'news, 90 days → stale');
const noDate = newsLeadAge({ publishedAt: null }, NOW);
check(noDate.state === 'unknown' && noDate.label === 'age unknown' && noDate.days === null, 'news, no date → age unknown, no days', noDate.why);
is(newsLeadAge({ publishedAt: '2026-09-13T08:00:00+00:00' }, NOW).state, 'fresh', 'news, a timestamp today → fresh');
check(newsLeadAge({ publishedAt: '2026-10-01' }, NOW).days === 0, 'a date in the future is 0 days old, not negative');

// Tender: flag at 180, stale at 365, from the award date when the notice states one.
is(tenderLeadAge({ awardDate: ago(179), awardBasis: 'award decision' }, NOW).state, 'fresh', 'award, 179 days → fresh');
is(tenderLeadAge({ awardDate: ago(180), awardBasis: 'award decision' }, NOW).state, 'flagged', 'award, 180 days → flagged');
is(tenderLeadAge({ awardDate: ago(364), awardBasis: 'award decision' }, NOW).state, 'flagged', 'award, 364 days → flagged');
is(tenderLeadAge({ awardDate: ago(365), awardBasis: 'contract concluded' }, NOW).state, 'stale', 'award, 365 days → stale');
const decidedOld = tenderLeadAge({ awardDate: ago(400), awardBasis: 'award decision', publishedAt: ago(10) }, NOW);
check(decidedOld.state === 'stale' && decidedOld.basis === 'award decision', 'the award date wins over a recent publication date', decidedOld.why);
const pubOnly = tenderLeadAge({ awardDate: null, publishedAt: ago(200) }, NOW);
check(pubOnly.state === 'flagged' && /no award date/.test(pubOnly.basis ?? ''), 'no award date → the notice publication date, and it says so', pubOnly.why);
is(tenderLeadAge({}, NOW).state, 'unknown', 'award with no date at all → age unknown');

// Postings: flag at 60, never stale.
is(postingAge({ posted_at: ago(59) }, NOW).state, 'fresh', 'posting, 59 days → fresh');
is(postingAge({ posted_at: ago(60) }, NOW).state, 'flagged', 'posting, 60 days → flagged');
is(postingAge({ posted_at: ago(443) }, NOW).state, 'flagged', 'posting, 443 days → still only flagged');
const firstSeen = postingAge({ posted_at: null, first_seen_at: `${ago(70)}T09:00:00Z` }, NOW);
check(firstSeen.state === 'flagged' && /first seen/.test(firstSeen.basis ?? ''), 'no posting date → first seen, and it says so', firstSeen.why);
is(postingAge({ posted_at: ago(5), first_seen_at: ago(90) }, NOW).state, 'fresh', 'the posting date wins over first seen');
is(postingAge({}, NOW).state, 'unknown', 'posting with neither date → age unknown');

// Re-adverts: distinct days inside 180 days; same-day adverts are openings, not reposts.
const sameDay = reAdverts([{ first_seen_at: '2026-09-10T08:00:00Z' }, { first_seen_at: '2026-09-10T08:01:00Z' }, { first_seen_at: '2026-09-10T08:02:00Z' }], NOW);
check(sameDay.count === 0 && !sameDay.boosted, 'three adverts on one day (wet pro) → not re-advertised', JSON.stringify(sameDay));
const kymar = reAdverts([{ posted_at: '2026-07-22', first_seen_at: '2026-09-10' }, { posted_at: '2026-06-12', first_seen_at: '2026-09-10' }], NOW);
check(kymar.count === 1 && !kymar.boosted, 'Kymar, posted 12 Jun and 22 Jul → re-advertised once, not raised', JSON.stringify(kymar));
const thrice = reAdverts([{ posted_at: ago(100) }, { posted_at: ago(50) }, { posted_at: ago(5) }], NOW);
check(thrice.count === 2 && thrice.boosted, 'three advert days inside 180 → re-advertised twice, raised', JSON.stringify(thrice));
const oldOne = reAdverts([{ posted_at: ago(300) }, { posted_at: ago(50) }, { posted_at: ago(5) }], NOW);
check(oldOne.count === 1 && !oldOne.boosted, 'an advert older than 180 days does not count', JSON.stringify(oldOne));
const undated = reAdverts([{ posted_at: null, first_seen_at: null }, { posted_at: ago(3) }], NOW);
check(undated.count === 0, 'an advert with no date counts for nothing', JSON.stringify(undated));

// Sorting: unknown with fresh; flagged below; stale lowest; a raised role above all.
check(ageSink('unknown') === ageSink('fresh'), 'age unknown sorts with fresh, not below');
check(ageSink('fresh') < ageSink('flagged') && ageSink('flagged') < ageSink('stale'), 'fresh, then flagged, then stale');
check(ageSink('flagged', true) < ageSink('fresh'), 'a re-advertised role goes above fresh, even when its newest advert is ageing');
check(daysSince('2026-09-12', NOW) === 1, 'yesterday is 1 day old');

// The award date, read back from a notice's stored text.
const award = (awardDate: Award['awardDate']): Award => ({
  noticeId: '1-2026', noticeType: 'can-standard', url: 'https://ted.europa.eu/en/notice/-/detail/1-2026', publishedOn: '2026-09-01',
  buyers: ['A buyer'], buyerCountries: ['DNK'], winners: ['A winner'], winnerDomain: null, value: null, awardDate,
  title: 't', titleLang: 'eng', description: null, descriptionLang: null, cpv: [], mainCpv: [], country: 'DK', countriesRaw: ['DNK'], city: null,
});
const text = (d: Award['awardDate']) => awardText(award(d), { 'publication-number': '1-2026' } as any, '2026-09-01T00:00:00Z');
check(JSON.stringify(awardDateFromText(text({ date: '2026-05-02', which: 'award decision' }))) === JSON.stringify({ date: '2026-05-02', which: 'award decision' }), 'award decision date read back from the notice text');
check(awardDateFromText(text({ date: '2026-04-30', which: 'contract concluded' }))?.which === 'contract concluded', 'contract conclusion date read back, with its kind');
check(awardDateFromText(text(null)) === null, '"not stated in the notice" reads back as no date');

console.log(failures === 0 ? '\nlead age: all checks passed' : `\nlead age: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
