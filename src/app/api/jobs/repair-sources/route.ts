import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/server';
import { httpGet } from '@/lib/http';
import { fetchPage, articleLinks } from '@/lib/fetch-page';
export const maxDuration = 300;

/**
 * Find the news page again when a source's URL has rotted.
 *
 * 15 of the 44 priority sources pointed at a page that no longer exists — shell.com/media/news,
 * subsea7.com/en/media/news, fluor.com/newsroom and the rest are all 404 now. A crawl cannot
 * report that as "no qualifying news": it never read anything.
 *
 * For each source that does not answer 200:
 *   403 or a bot wall   try a browser; if that reads it, record browser:true and keep the URL
 *   404 or gone         look on the site's own root for its newsroom, and prove the candidate
 *                       works by finding article links on it before adopting it
 *   nothing works       switch it off with the reason, rather than leave it failing silently
 *
 * Nothing is adopted on the strength of its name: a candidate must actually yield links.
 *
 *   POST /api/jobs/repair-sources?tier=priority&limit=15&dry=1
 */
const authorised = (req: Request) => {
  const s = process.env.CRON_SECRET;
  return !!s && (req.headers.get('x-cron-secret') === s || req.headers.get('authorization') === `Bearer ${s}`);
};

export const GET = (req: Request) => run(req);
export const POST = (req: Request) => run(req);

/** Words a site uses for the page we want, in the languages our sources are written in. */
const NEWSY = /news|press|media|newsroom|insight|stories|updates|aktuelt|nyheder|nyheter|presse|pressemitteilung|actualite|noticias|tenders|projects/i;

async function candidatesFrom(rootUrl: string, browser = false): Promise<string[]> {
  const root = await fetchPage(rootUrl, browser ? { force: 'browser' } : {});
  if (root.status !== 'live') return [];
  let origin: string;
  try { origin = new URL(root.url).origin; } catch { return []; }
  const out: string[] = [];
  for (const raw of root.links) {
    try {
      const u = new URL(raw);
      if (u.origin !== origin) continue;
      u.hash = ''; u.search = '';
      const path = u.pathname;
      if (!NEWSY.test(path)) continue;
      // A newsroom is near the top of the tree; /news/2019/some-old-story is a story, not the index.
      const seg = path.split('/').filter(Boolean);
      if (seg.length > 3) continue;
      // The LAST segment has to be the index word, or we adopt an item off the index page:
      // /projects/stegra-0 matched "projects" and would have made one project page the source.
      const last = (seg[seg.length - 1] ?? '').replace(/\.(html?|php|aspx)$/i, '');
      if (!NEWSY.test(last)) continue;
      const href = u.toString().replace(/\/$/, '');
      if (!out.includes(href)) out.push(href);
    } catch { /* not a URL */ }
  }
  // Shortest paths first: /news before /about/news before /en/media/news-and-insights.
  return out.sort((a, b) => a.length - b.length).slice(0, 12);
}

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const p = new URL(req.url).searchParams;
  const limit = Number(p.get('limit') ?? 15);
  const dry = p.get('dry') === '1';
  const tier = p.get('tier');
  const only = p.get('only');

  let q = db.from('sources').select('id, name, url, link_rule, tier').eq('enabled', true).order('id');
  if (tier) q = q.eq('tier', tier);
  if (only) {
    const terms = only.split(',').map((t) => t.trim()).filter(Boolean);
    q = terms.length > 1 ? q.or(terms.map((t) => `url.ilike.%${t}%`).join(',')) : q.ilike('url', `%${terms[0]}%`);
  }
  const { data: sources, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const fixed: any[] = [];
  const stillBroken: any[] = [];
  let checked = 0;

  for (const src of sources ?? []) {
    if (fixed.length + stillBroken.length >= limit) break;
    const head = await httpGet(src.url, {}, 15000);
    checked++;
    if (head.ok) continue;                                   // this one is fine

    // Blocked rather than gone: a browser may well read it.
    if (head.status === 403 || head.status === 429) {
      const rendered = await fetchPage(src.url, { force: 'browser' });
      if (rendered.status === 'live' && articleLinks(rendered, 15).length > 0) {
        if (!dry) await db.from('sources').update({ link_rule: JSON.stringify({ browser: true }) }).eq('id', src.id);
        fixed.push({ url: src.url, action: 'browser only', why: `HTTP ${head.status} to a plain fetch, ${articleLinks(rendered, 15).length} links through a browser` });
        continue;
      }
    }

    // Gone, or walled: ask the site itself where its newsroom lives now. A site that refused
    // the plain fetch will refuse it for the candidates too, so read those through a browser.
    const blocked = head.status === 403 || head.status === 429 || head.status === 0;
    let origin: string;
    try { origin = new URL(src.url).origin; } catch { origin = ''; }
    let adopted: { url: string; links: number; via: string } | null = null;
    for (const cand of origin ? await candidatesFrom(origin, blocked) : []) {
      if (cand.replace(/\/$/, '') === src.url.replace(/\/$/, '')) continue;
      const page = await fetchPage(cand, blocked ? { force: 'browser' } : {});
      if (page.status !== 'live') continue;
      const links = articleLinks(page, 15).length;
      // Proof, not a promising name: the page has to carry articles.
      if (links >= 3) { adopted = { url: cand, links, via: page.via }; break; }
    }

    if (adopted) {
      if (!dry) await db.from('sources').update({ url: adopted.url, ...(adopted.via === 'browser' ? { link_rule: JSON.stringify({ browser: true }) } : {}) }).eq('id', src.id);
      fixed.push({ url: src.url, action: 'url replaced', now: adopted.url, why: `the old page returned ${head.status || 'no connection'}; the new one carries ${adopted.links} article links, read via ${adopted.via}` });
    } else {
      const why = `${src.url} returns ${head.status || `no connection (${head.error ?? 'unknown'})`} and no newsroom on the site carries article links`;
      if (!dry) {
        await db.from('sources').update({ enabled: false }).eq('id', src.id);
        // Separate, so switching the source off does not depend on migration 0011 being in.
        await db.from('sources').update({ tier_reason: why }).eq('id', src.id);
      }
      stillBroken.push({ url: src.url, why });
    }
  }

  console.log(`[repair-sources] checked=${checked} fixed=${fixed.length} disabled=${stillBroken.length}`);
  return NextResponse.json({ ok: true, dry, checked, fixed, stillBroken });
}
