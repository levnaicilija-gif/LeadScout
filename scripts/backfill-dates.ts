/**
 * Fill articles.published_at and job_posts.posted_at from pages already read.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-dates.ts            # report what it would write
 *   npx tsx --env-file=.env.local scripts/backfill-dates.ts --write    # write it
 *
 * Each empty row's own URL is fetched again over plain HTTP — free, no browser — because the
 * stored text kept no HTML and the dates live in its metadata. What counts is in src/lib/page-dates.ts.
 * A news article with no metadata date may still carry a dateline in its stored text; that is used
 * only once migration 0021 is applied, so its source can be recorded beside it. Award notices are
 * already dated by TED and only get their source recorded.
 *
 * Nothing already dated is touched. Exits 1 if a write fails.
 */
import { createClient } from '@supabase/supabase-js';
import { httpGet } from '../src/lib/http';
import { datesFromHtml, datelineFromText } from '../src/lib/page-dates';
import { hasColumn } from '../src/lib/schema-features';
import { probeAdmin } from '../src/lib/test-data';

const db = probeAdmin();
const WRITE = process.argv.includes('--write');
const TED = 'https://ted.europa.eu/';

async function all<T>(q: (from: number) => PromiseLike<{ data: T[] | null; error: any }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) return rows;
  }
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

(async () => {
  const articleSource = await hasColumn(db, 'articles', 'published_at_source');
  const postingSource = await hasColumn(db, 'job_posts', 'posted_at_source');
  console.log(`${WRITE ? 'WRITING' : 'dry run'} · 0021 applied: articles.published_at_source ${articleSource}, job_posts.posted_at_source ${postingSource}\n`);
  let failures = 0;

  // ---------------------------------------------------------------- articles
  const articles = await all<any>((f) => db.from('articles').select('id, url, text, fetched_at, published_at').is('published_at', null).range(f, f + 999));
  const tally: Record<string, number> = {};
  const count = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
  const samples: string[] = [];
  await pool(articles.filter((a) => !a.url.startsWith(TED)), 6, async (a) => {
    const res = await httpGet(a.url, {}, 20000);
    let found = res.ok ? datesFromHtml(res.body, a.fetched_at).published : null;
    if (!found && articleSource) found = datelineFromText(a.text ?? '', a.fetched_at);
    if (!found) { count(res.ok ? 'no date on the page' : `page not read (${res.status || res.error})`); return; }
    count(found.via);
    if (samples.length < 12) samples.push(`  ${found.date}  ${found.via.padEnd(40)} ${a.url.slice(0, 90)}`);
    if (!WRITE) return;
    const { error } = await db.from('articles').update({ published_at: found.date, ...(articleSource ? { published_at_source: found.via } : {}) }).eq('id', a.id).is('published_at', null);
    if (error) { failures++; console.log(`  write failed ${a.url}: ${error.message}`); }
  });
  // Without 0021 a dateline cannot be told apart from metadata, so it is only counted, never written.
  if (!articleSource) {
    let wouldDateline = 0;
    for (const a of articles.filter((x) => !x.url.startsWith(TED))) if (datelineFromText(a.text ?? '', a.fetched_at)) wouldDateline++;
    console.log(`(datelines found in stored text, held back until 0021: up to ${wouldDateline}, before subtracting pages that had metadata)`);
  }
  if (articleSource && WRITE) {
    const { error } = await db.from('articles').update({ published_at_source: 'TED publication date' }).like('url', `${TED}%`).not('published_at', 'is', null).is('published_at_source', null);
    if (error) { failures++; console.log(`  TED source write failed: ${error.message}`); }
  }
  const newsTotal = articles.filter((a) => !a.url.startsWith(TED)).length;
  console.log(`articles without a date (news): ${newsTotal}`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
  console.log(samples.join('\n'));

  // ---------------------------------------------------------------- postings
  const posts = await all<any>((f) => db.from('job_posts').select('id, source_url, first_seen_at, posted_at').is('posted_at', null).range(f, f + 999));
  const ptally: Record<string, number> = {};
  await pool(posts, 4, async (p) => {
    const res = await httpGet(p.source_url, {}, 20000);
    const found = res.ok ? datesFromHtml(res.body, new Date().toISOString()).posted : null;
    const k = found ? found.via : res.ok ? 'no JobPosting date on the page' : `page not read (${res.status || res.error})`;
    ptally[k] = (ptally[k] ?? 0) + 1;
    if (!found || !WRITE) return;
    const { error } = await db.from('job_posts').update({ posted_at: found.date, ...(postingSource ? { posted_at_source: found.via } : {}) }).eq('id', p.id).is('posted_at', null);
    if (error) { failures++; console.log(`  write failed ${p.source_url}: ${error.message}`); }
  });
  console.log(`\npostings without a date: ${posts.length}`);
  for (const [k, v] of Object.entries(ptally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);

  // ------------------------------------------------ sources for dates written before 0021
  // A date written before the column existed has no recorded source. Read the page again and
  // record the source only when it still yields that exact date; otherwise leave it unrecorded
  // rather than label a date with a source that did not produce it.
  if (articleSource && postingSource) {
    const undocumented = await all<any>((f) => db.from('articles').select('id, url, text, fetched_at, published_at').not('published_at', 'is', null).is('published_at_source', null).not('url', 'like', `${TED}%`).range(f, f + 999));
    const src: Record<string, number> = {};
    await pool(undocumented, 6, async (a) => {
      const res = await httpGet(a.url, {}, 20000);
      const meta = res.ok ? datesFromHtml(res.body, a.fetched_at).published : null;
      const line = datelineFromText(a.text ?? '', a.fetched_at);
      const via = meta && meta.date === a.published_at ? meta.via : line && line.date === a.published_at ? line.via : null;
      src[via ?? 'no source reproduces the stored date — left unrecorded'] = (src[via ?? 'no source reproduces the stored date — left unrecorded'] ?? 0) + 1;
      if (via && WRITE) await db.from('articles').update({ published_at_source: via }).eq('id', a.id).is('published_at_source', null);
    });
    const undocPosts = await all<any>((f) => db.from('job_posts').select('id, source_url, posted_at').not('posted_at', 'is', null).is('posted_at_source', null).range(f, f + 999));
    await pool(undocPosts, 4, async (p) => {
      const res = await httpGet(p.source_url, {}, 20000);
      const found = res.ok ? datesFromHtml(res.body, new Date().toISOString()).posted : null;
      const via = found && found.date === p.posted_at ? found.via : null;
      src[`posting: ${via ?? 'no source reproduces the stored date — left unrecorded'}`] = (src[`posting: ${via ?? 'no source reproduces the stored date — left unrecorded'}`] ?? 0) + 1;
      if (via && WRITE) await db.from('job_posts').update({ posted_at_source: via }).eq('id', p.id).is('posted_at_source', null);
    });
    console.log(`\ndates written before 0021 (${undocumented.length} articles, ${undocPosts.length} postings), source recorded where the page still gives the same date:`);
    for (const [k, v] of Object.entries(src).sort((x, y) => y[1] - x[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
  }

  process.exit(failures ? 1 : 0);
})();
