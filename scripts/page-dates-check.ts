/**
 * Pins which dates on a page count as its publication or posting date. No network.
 *
 *   npx tsx scripts/page-dates-check.ts
 *
 * The cases come from real pages read on 2026-09-13. Exits 1 on any failure.
 */
import { datesFromHtml, datelineFromText } from '../src/lib/page-dates';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const READ = '2026-09-13T12:00:00Z';
const ld = (o: object) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

const news = datesFromHtml(`<html><head>${ld({ '@type': 'NewsArticle', datePublished: '2026-09-10T08:28:46Z' })}</head><body></body></html>`, READ);
check(news.published?.date === '2026-09-10' && /NewsArticle/.test(news.published.via), 'JSON-LD NewsArticle.datePublished is the publication date', JSON.stringify(news.published));

const graph = datesFromHtml(`<html><head>${ld({ '@graph': [{ '@type': 'WebPage', datePublished: '2020-12-16T14:33:00+01:00' }, { '@type': 'Article', datePublished: '2026-07-31T19:52:14+00:00' }] })}</head></html>`, READ);
check(graph.published?.date === '2026-07-31', 'inside @graph, the Article date wins over the WebPage date', JSON.stringify(graph.published));

const siteDate = datesFromHtml(`<html><head>${ld({ '@type': 'WebPage', datePublished: '2020-12-16T14:33:00+01:00' })}</head><body><aside><time datetime="2020-12-15T00:00:00+01:00"></time></aside></body></html>`, READ);
check(siteDate.published === null, "a WebPage date (the site's page record) and a sidebar <time> are not the article's date", JSON.stringify(siteDate.published));

const meta = datesFromHtml('<html><head><meta property="article:published_time" content="2026-09-03T09:48:50+00:00"></head></html>', READ);
check(meta.published?.date === '2026-09-03', 'meta article:published_time counts');

const future = datesFromHtml(`<html><head>${ld({ '@type': 'NewsArticle', datePublished: '2027-01-01' })}</head></html>`, READ);
check(future.published === null, 'a date after the page was read is refused');

const job = datesFromHtml(`<html><head>${ld({ '@type': 'JobPosting', datePosted: '2026-07-22T10:50:10+02:00' })}${ld({ '@type': 'WebPage', datePublished: '2026-05-18T08:11:02+00:00' })}</head></html>`, READ);
check(job.posted?.date === '2026-07-22' && job.published === null, 'JobPosting.datePosted is the posting date; a WebPage date is not', JSON.stringify(job));

const noJob = datesFromHtml(`<html><head>${ld({ '@type': 'WebPage', datePublished: '2026-05-18T08:11:02+00:00' })}</head></html>`, READ);
check(noJob.posted === null, 'a careers page with only a WebPage date has no posting date');

const vattenfall = datelineFromText('Skip to content Go to main navigation Menu PRESS RELEASE WIND 4 AUGUST 2026, 09:46 CET 1 MIN Vattenfall awarded Hesselø', READ);
check(vattenfall?.date === '2026-08-04', 'a dateline introduced as a press release counts', JSON.stringify(vattenfall));

const published = datelineFromText('Analysis Published 9 September 2026, 09:59 Updated 9 September 2026, 09:59 The world’s battery storage', READ);
check(published?.date === '2026-09-09', '"Published 9 September 2026" counts, and the same day marked Updated does not add a second date', JSON.stringify(published));

const equinor = datelineFromText('Copyright 2026 Equinor ASA Announcement of cash dividend for the first quarter of 2026 Record date 6 May 2026', READ);
check(equinor === null, 'a date in the body with no publication cue does not count', JSON.stringify(equinor));

const updated = datelineFromText('Explore Shell.com Page last updated: 29 Jun 2026 Our strategy', READ);
check(updated === null, '"Page last updated" is not a publication date', JSON.stringify(updated));

const slash = datelineFromText('News Published 03/04/2026 Something happened', READ);
check(slash === null, 'a slash date is refused: 03/04/2026 is two different days');

const two = datelineFromText('News 1 September 2026 · Press release 3 September 2026 · the update', READ);
check(two === null, 'two different cued dates in the opening lines means no dateline', JSON.stringify(two));

console.log(failures === 0 ? '\npage dates: all checks passed' : `\npage dates: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
