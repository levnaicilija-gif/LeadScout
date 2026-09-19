/**
 * Find the RSS/Atom feed a source publishes, and point `sources.link_rule` at it where that is a
 * net gain (2026-09-19).
 *
 *   npx tsx --env-file=.env.local scripts/feed-discovery.ts            # report only, writes nothing
 *   npx tsx --env-file=.env.local scripts/feed-discovery.ts --write    # store the rules it decided on
 *   npx tsx --env-file=.env.local scripts/feed-discovery.ts --type=all --limit 20
 *   npx tsx --env-file=.env.local scripts/feed-discovery.ts --type=tender --only=offshorewind --write
 *
 * `--only=<substrings>` names sources by url or name, the same way radar-batch's own `only=` does.
 * It exists so a single row can be put through the SAME measured criterion as a full pass rather
 * than hand-edited: offshorewind.biz is two enabled priority rows, one news and one tender, and the
 * tender one was switched by naming it here after the news pass had already proved its feed.
 *
 * Nothing here is a new crawl path: fetchPage already reads a feed when the URL it is given IS one
 * (`via: 'rss'`), and articleLinks already trusts feed items over its shape test. `link_rule.index`
 * (0005) already makes the crawl read a different URL than the source's. All that was missing was
 * anything to discover which sources have a feed and write that down — 1 of 610 sources carried a
 * link_rule at all before this, and it was `{browser:true}`, not a feed. No model call, no browser,
 * so a run costs nothing and never touches the daily cap.
 *
 * THREE THINGS MEASURED FIRST, each of which changes what this has to do:
 *
 * 1. Guessing the well-known paths finds every feed that autodiscovery finds, and six more: on 30
 *    enabled news sources, 11 feeds found by guessing and 5 by `<link rel="alternate">`, with none
 *    advertised that a guess missed. Both are still collected, because of (2).
 *
 * 2. `www.example.com` and `example.com` are DIFFERENT ORIGINS, and articleLinks drops every link
 *    whose origin differs from the index's (fetch-page.ts:159). So a feed can parse perfectly and
 *    yield NOTHING: offshorewind.biz's 50-item feed keeps 50 links read as `offshorewind.biz/feed`
 *    and 0 read as `www.offshorewind.biz/feed`. There is no universal rule — oceanwinds.com is the
 *    other way round (www works, bare gives 0). Every candidate is therefore tried in BOTH host
 *    forms and judged on what articleLinks actually keeps, never on whether the XML parsed.
 *
 * 3. `link_rule.index` REPLACES the index page rather than adding to it, so "the feed has links" is
 *    not enough — switching offshore-energy.biz to its feed would trade 36 home-page links for 10,
 *    none of them new. A source is only switched when, at the cap radar actually uses, the feed
 *    gives at least as many links AND at least one the home page did not.
 */
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { fetchPage, articleLinks, type Fetched } from '../src/lib/fetch-page';
import { httpGet } from '../src/lib/http';
import { ruleFor } from '../src/lib/source-rules';

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const TYPE = args.find((a) => a.startsWith('--type='))?.split('=')[1] ?? 'news,company_press';
const ONLY = (args.find((a) => a.startsWith('--only='))?.split('=')[1] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const LIMIT = Number(args.find((a) => a.startsWith('--limit'))?.split(/[= ]/)[1] ?? args[args.indexOf('--limit') + 1] ?? 0) || 0;

/** radar-batch's own cap (radar-batch.ts:163). Every judgement is made at the number it really uses. */
const PROD_LIMIT = 15;
/** Wider, to report what a source could give if the cap were raised. Never used for the decision. */
const WIDE_LIMIT = 60;

/** Where feeds actually live. Ordered by how often they hit on this corpus. */
const COMMON_PATHS = ['/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml', '/feed/'];

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const capped = (n: number) => Math.min(n, PROD_LIMIT);

/** Both host forms of a URL — see (2) above. Order matters only for reporting. */
function hostVariants(url: string): string[] {
  try {
    const u = new URL(url);
    const bare = u.hostname.replace(/^www\./, '');
    const out = new Set<string>();
    for (const h of [u.hostname, bare, `www.${bare}`]) {
      const v = new URL(u.toString());
      v.hostname = h;
      out.add(v.toString());
    }
    return [...out];
  } catch { return [url]; }
}

/** Feed URLs the page advertises, per the HTML standard. */
function advertised(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const out: string[] = [];
  $('link[rel="alternate"]').each((_, el) => {
    const type = String($(el).attr('type') ?? '');
    const href = $(el).attr('href');
    if (!href || !/rss|atom|xml/i.test(type)) return;
    try { out.push(new URL(href, baseUrl).toString()); } catch { /* unusable href */ }
  });
  return [...new Set(out)];
}

type Candidate = { url: string; via: 'advertised' | 'guessed'; kept: string[]; raw: number; title: string };

/** A candidate counts only if the crawl's own reader calls it a feed AND articleLinks keeps links. */
async function judge(url: string, via: Candidate['via']): Promise<Candidate | null> {
  const got: Fetched = await fetchPage(url, { allowBrowser: false });
  if (got.status !== 'live' || got.via !== 'rss' || got.links.length === 0) return null;
  const kept = articleLinks(got, WIDE_LIMIT);
  if (kept.length === 0) return null; // parsed, but every item was dropped on origin — see (2)
  return { url, via, kept, raw: got.links.length, title: got.title };
}

async function main() {
  const types = TYPE === 'all' ? null : TYPE.split(',').map((t) => t.trim()).filter(Boolean);
  let q = admin.from('sources').select('id, name, url, type, tier, link_rule').eq('enabled', true);
  if (types) q = q.in('type', types);
  const { data, error } = await q.order('id');
  if (error) throw new Error(`could not read sources: ${error.message}`);
  let sources = data ?? [];
  if (ONLY.length) sources = sources.filter((s: any) => ONLY.some((o) => `${s.url ?? ''} ${s.name ?? ''}`.toLowerCase().includes(o)));
  if (LIMIT) sources = sources.slice(0, LIMIT);

  console.log(`feed discovery over ${sources.length} enabled source(s)${types ? ` of type ${types.join('/')}` : ''}${ONLY.length ? ` matching ${ONLY.join('/')}` : ''}`);
  console.log(`${WRITE ? 'WRITING link_rule where the feed wins' : 'REPORT ONLY — nothing will be written (pass --write to store)'}`);
  console.log(`judged at radar's own cap of ${PROD_LIMIT} links\n`);

  const rows: any[] = [];
  let switched = 0, wouldSwitch = 0, foundFeed = 0, skippedHasRule = 0, writeErrors = 0;

  for (const src of sources) {
    const name = src.name ?? '(unnamed)';
    // A source that already has a rule — in the database OR hardcoded in source-rules.ts — is left
    // alone. Writing link_rule would override the hardcoded entry entirely (ruleFor checks the DB
    // first), so a pattern or browser rule someone worked out would be silently dropped for a feed.
    const existing = ruleFor(src.url, src.link_rule);
    if (existing) {
      skippedHasRule++;
      rows.push({ name, url: src.url, outcome: 'skipped — already has a rule', why: existing.why });
      console.log(`SKIP  ${name} — already has a rule (${existing.why})`);
      continue;
    }

    // ---- what the crawl gets today, at the cap it really uses
    const home = await fetchPage(src.url, { allowBrowser: false });
    const homeAll = home.status === 'live' ? articleLinks(home, WIDE_LIMIT) : [];
    const homeN = capped(homeAll.length);

    // ---- candidates: advertised first (authoritative, and usually the canonical host), then guesses
    const raw = await httpGet(src.url);
    const adverts = raw.ok ? advertised(raw.body, raw.url) : [];
    const seen = new Set<string>();
    const tries: { url: string; via: Candidate['via'] }[] = [];
    for (const a of adverts) for (const v of hostVariants(a)) if (!seen.has(v)) { seen.add(v); tries.push({ url: v, via: 'advertised' }); }
    for (const p of COMMON_PATHS) {
      let base: string;
      try { base = new URL(p, src.url).toString(); } catch { continue; }
      for (const v of hostVariants(base)) if (!seen.has(v)) { seen.add(v); tries.push({ url: v, via: 'guessed' }); }
    }

    // Keep the BEST working candidate, not the first: two host forms can both work and give
    // different counts, and the advertised one is preferred only on a tie.
    let best: Candidate | null = null;
    for (const t of tries) {
      const c = await judge(t.url, t.via);
      if (!c) continue;
      if (!best
        || capped(c.kept.length) > capped(best.kept.length)
        || (capped(c.kept.length) === capped(best.kept.length) && c.via === 'advertised' && best.via === 'guessed')) best = c;
    }

    if (!best) {
      rows.push({ name, url: src.url, outcome: 'no feed', home: homeN });
      console.log(`  --  ${name} — no feed (home ${homeN})`);
      continue;
    }
    foundFeed++;

    // ---- the decision: never fewer links than today, and it must add something
    const feedN = capped(best.kept.length);
    const homeSet = new Set(homeAll.map((u) => u.replace(/\/$/, '').split('?')[0]));
    const newOnes = best.kept.filter((u) => !homeSet.has(u.replace(/\/$/, '').split('?')[0]));
    const win = feedN >= homeN && newOnes.length > 0;

    const line = `home ${String(homeN).padStart(2)} → feed ${String(feedN).padStart(2)} (+${newOnes.length} new, ${best.raw} in the feed) ${best.via}`;
    if (!win) {
      const why = feedN < homeN ? `fewer links at the cap (${feedN} < ${homeN})` : 'adds nothing the home page does not already give';
      rows.push({ name, url: src.url, outcome: 'found, not switched', feed: best.url, home: homeN, feedN, newOnes: newOnes.length, why });
      console.log(`  --  ${name} — ${line} — NOT switched: ${why}`);
      continue;
    }

    wouldSwitch++;
    let outcome = 'would switch';
    if (WRITE) {
      const rule = JSON.stringify({ index: best.url });
      const { error: upErr } = await admin.from('sources').update({ link_rule: rule }).eq('id', src.id);
      if (upErr) { writeErrors++; outcome = `WRITE FAILED: ${upErr.message}`; }
      else { switched++; outcome = 'switched'; }
    }
    rows.push({ name, url: src.url, outcome, feed: best.url, home: homeN, feedN, newOnes: newOnes.length, title: flat(best.title).slice(0, 60) });
    console.log(`  ${WRITE ? '>>' : '~~'}  ${name} — ${line} — ${outcome}`);
    console.log(`        ${best.url}`);
  }

  // ---- the report the decision to run this rests on
  console.log(`\n================ FEED DISCOVERY ================`);
  console.log(`sources examined:            ${rows.length}`);
  console.log(`  skipped (already ruled):   ${skippedHasRule}`);
  console.log(`  a working feed was found:  ${foundFeed}`);
  console.log(`  feed won on the criterion: ${wouldSwitch}`);
  console.log(`  ${WRITE ? 'link_rule written:         ' + switched : 'link_rule NOT written (report only)'}`);
  if (writeErrors) console.log(`  WRITE FAILURES:            ${writeErrors}`);

  const changed = rows.filter((r) => r.outcome === 'switched' || r.outcome === 'would switch');
  const foundNotSwitched = rows.filter((r) => r.outcome === 'found, not switched');
  if (changed.length) {
    console.log(`\nbefore / after, at radar's cap of ${PROD_LIMIT}:`);
    let before = 0, after = 0;
    for (const r of changed) {
      before += r.home; after += r.feedN;
      console.log(`  ${String(r.home).padStart(2)} → ${String(r.feedN).padStart(2)}  (+${String(r.newOnes).padStart(2)} the scrape misses)  ${r.name}`);
    }
    console.log(`  ${String(before).padStart(2)} → ${String(after).padStart(2)}  TOTAL across ${changed.length} source(s)`);
  }
  if (foundNotSwitched.length) {
    console.log(`\nhad a feed, deliberately left alone:`);
    for (const r of foundNotSwitched) console.log(`  ${r.name} — ${r.why}`);
  }
  console.log(`\nre-runnable: a second run re-reads every source and skips the ones this one ruled.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
