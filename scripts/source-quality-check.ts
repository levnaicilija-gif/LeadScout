/**
 * Pins how a lead's source is flagged. No network: cases are shaped like pages read on 2026-09-13,
 * and one real stored article per paywall kind is read from the database (SELECT only).
 *
 *   npx tsx --env-file=.env.local scripts/source-quality-check.ts
 *
 * Exits 1 on any failure.
 */
import { createClient } from '@supabase/supabase-js';
import { sourceFlag } from '../src/lib/source-quality';
import { probeAdmin } from '../src/lib/test-data';

const db = probeAdmin();
let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const page = (over: Partial<Parameters<typeof sourceFlag>[0]>) => ({ url: 'https://www.example.invalid/news/2026/09/dwt-returns-to-riffgat-offshore-wind-farm', status: 'live' as const, text: 'x'.repeat(4000), title: 'DWT Returns to Riffgat Offshore Wind Farm', note: undefined, links: [], via: 'http' as const, ...over });

(async () => {
  const stored = async (host: string) => {
    const { data } = await db.from('articles').select('url, title, text').ilike('url', `%${host}%`).limit(20);
    return data ?? [];
  };

  const geo = (await stored('geodrillinginternational')).find((a: any) => /to continue reading/i.test(a.text ?? ''));
  check(!!geo, 'a stored geodrillinginternational article carries "to continue reading"');
  if (geo) { const r = sourceFlag(page({ url: geo.url, text: geo.text, title: geo.title }), { requestedUrl: geo.url }); check(r.flag === 'paywall', 'geodrillinginternational → paywall', r.why); }

  const rech = (await stored('rechargenews')).find((a: any) => /for subscribers/i.test(a.text ?? ''));
  check(!!rech, 'a stored rechargenews article carries "for subscribers"');
  if (rech) { const r = sourceFlag(page({ url: rech.url, text: rech.text, title: rech.title }), { requestedUrl: rech.url }); check(r.flag === 'paywall', 'rechargenews → paywall', `${r.flag}: ${r.why}`); }

  const dwt = (await stored('dwt-returns-to-riffgat'))[0];
  if (dwt) { const r = sourceFlag(page({ url: dwt.url, text: dwt.text, title: dwt.title }), { requestedUrl: dwt.url }); check(r.flag === 'ok', 'the DWT/Riffgat article, footer "Subscribe →" and all, is ok', `${r.flag}: ${r.why}`); }

  check(sourceFlag(page({ status: 'not_found', text: '', note: 'HTTP 404' }), { requestedUrl: page({}).url }).flag === 'broken', 'HTTP 404 → broken');
  check(sourceFlag(page({ status: 'not_found', text: '', note: 'HTTP 403' }), { requestedUrl: page({}).url }).flag === 'unreachable', 'HTTP 403 → unreachable');
  check(sourceFlag(page({ text: 'Please sign in to read this member briefing. ' + 'y'.repeat(900) }), { requestedUrl: page({}).url }).flag === 'sign_in', '"Please sign in" on a short page → sign_in');
  const home = sourceFlag({ ...page({}), finalUrl: 'https://www.example.invalid/' }, { requestedUrl: page({}).url });
  check(home.flag === 'landing', 'a story link that redirects to the home page → landing', home.why);
  const section = sourceFlag(page({ title: 'Offshore wind news', text: 'Latest news from the offshore wind industry. '.repeat(40), links: Array.from({ length: 30 }, (_, i) => `https://www.example.invalid/news/2026/09/another-long-story-about-something-${i}`) }), { requestedUrl: page({}).url });
  check(section.flag === 'landing', 'a page naming none of the link\'s words and listing many stories → landing', section.why);
  check(sourceFlag(page({}), { requestedUrl: page({}).url, sourcePaywalled: true }).flag === 'ok', 'a paywalled source that returned a full article is ok');

  console.log(failures === 0 ? '\nsource quality: all checks passed' : `\nsource quality: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
