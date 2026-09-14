/** Item 19's rules on fixed dates: npx tsx scripts/compound-signals-check.ts */
import { compoundFor, boostedFit, boostedPressure, leadSignal, postingSignals, type Signal } from '../src/lib/compound-signals';

let failed = 0;
const check = (ok: boolean, what: string, got?: unknown) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` — ${JSON.stringify(got)}`}`); if (!ok) failed++; };
const now = new Date('2026-09-15T08:00:00Z');
const S = (type: Signal['type'], date: string, basis = 'x'): Signal => ({ type, date, basis });

// One type, any number of signals: untouched.
let c = compoundFor([S('hiring', '2026-09-10'), S('hiring', '2026-09-01'), S('hiring', '2026-08-20')], now);
check(c.factor === 1 && c.label === null && c.why === null, 'one signal type, however many signals, is not boosted', c);
check(boostedFit(70, c, 'NO').fit === 70 && !boostedFit(70, c, 'NO').boosted, 'no boost leaves fit exactly as it was', boostedFit(70, c, 'NO'));
check(boostedPressure('low', c).pressure === 'low', 'no boost leaves pressure exactly as it was');

// Two types inside 60 days, 12 days apart.
c = compoundFor([S('tender', '2026-09-01', 'award decision'), S('news', '2026-09-13', 'article published')], now);
check(c.factor === 1.1 && c.spanDays === 12 && c.label === 'boosted ×1.1: tender award + news mention', 'tender award + news mention, 12 days apart, is ×1.1', c);
check(/12 days apart/.test(c.why ?? '') && /award decision/.test(c.why ?? '') && /article published/.test(c.why ?? ''), 'the reason names each signal, its date and what the date is', c.why);
const f = boostedFit(70, c, 'DK');
check(f.fit === 77 && f.from === 70 && /Fit 70 → 77/.test(f.note ?? ''), 'fit 70 in Europe becomes 77 and says so', f);

// A signal outside the window does not count.
c = compoundFor([S('tender', '2026-06-01'), S('news', '2026-09-13')], now);
check(c.factor === 1, 'an award 106 days old does not combine with this week\'s story', c);

// Exactly 60 days counts; 61 does not.
check(compoundFor([S('tender', '2026-07-17'), S('hiring', '2026-09-14')], now).factor === 1.1, 'a signal 60 days old is inside the window');
check(compoundFor([S('tender', '2026-07-16'), S('hiring', '2026-09-14')], now).factor === 1, 'a signal 61 days old is outside it');

// Outside Europe the cap holds, and says so.
c = compoundFor([S('news', '2026-09-14'), S('hiring', '2026-09-14')], now);
const capped = boostedFit(25, c, 'US');
check(capped.fit === 25 && capped.boosted && /capped at 25/.test(capped.note ?? '') && /same day/.test(capped.note ?? ''), 'outside Europe a boost stops at the cap and the note says why the number did not move', capped);

// All three types — the most there are.
c = compoundFor([S('tender', '2026-09-01'), S('news', '2026-09-02'), S('hiring', '2026-09-03')], now);
check(c.factor === 1.2 && boostedFit(90, c, 'NO').fit === 100, 'all three types is ×1.2, and fit never passes 100', { c, f: boostedFit(90, c, 'NO') });
check(boostedPressure('medium', c).pressure === 'high' && boostedPressure('high', c).pressure === 'high' && /already the highest/.test(boostedPressure('high', c).note ?? ''), 'pressure goes one step up, never past high, and says so when it was high');

// Lead signal dates.
const tender = leadSignal({ source_url: 'https://ted.europa.eu/en/notice/-/detail/1#winner-1', created_at: '2026-09-10T00:00:00Z', lead_articles: [{ articles: { url: 'https://ted.europa.eu/en/notice/-/detail/1', published_at: '2026-08-20', award_date: '2026-07-30', award_date_basis: 'award decision' } }] });
check(tender?.type === 'tender' && tender.date === '2026-07-30' && tender.basis === 'award decision', 'an award is dated by its award decision', tender);
const undated = leadSignal({ source_url: 'https://example.com/story', created_at: '2026-09-10T00:00:00Z', lead_articles: [{ articles: { url: 'https://example.com/story', published_at: null } }] });
check(undated?.type === 'news' && undated.date === '2026-09-10' && /first read by Radar/.test(undated.basis), 'an undated story is dated by our first reading, and says so', undated);

// Postings: every advert and every re-advertised role is one signal type. Reposting alone never boosts (owner's decision 2026-09-15).
const once = postingSignals([{ role: 'Welder', posted_at: '2026-09-01' }, { role: 'Welder', posted_at: '2026-09-10' }], now);
check(once.every((s) => s.type === 'hiring') && compoundFor(once, now).factor === 1, 'a role re-advertised once alone never boosts its own company', once);
const twice = postingSignals([{ role: 'Rigger', posted_at: '2026-06-01' }, { role: 'Rigger', posted_at: '2026-08-01' }, { role: 'Rigger', posted_at: '2026-09-10' }], now);
check(twice.every((s) => s.type === 'hiring') && twice.some((s) => /Rigger re-advertised 2×/.test(s.basis)) && compoundFor(twice, now).factor === 1,
  'a role item 17 raised is a stronger open posting, not a second type: its own board alone never boosts', twice);
const withNews = compoundFor([...twice, S('news', '2026-09-12', 'article published')], now);
check(withNews.factor === 1.1 && /open Hiring now posting 2026-09-10 \(Rigger re-advertised 2×/.test(withNews.why ?? ''),
  'a raised role plus a news mention boosts, and the reason names the re-advertising', withNews.why);

console.log(failed ? `\n${failed} failed` : '\ncompound signals: all checks passed');
process.exitCode = failed ? 1 : 0;
