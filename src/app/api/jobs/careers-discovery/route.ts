import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import { supabaseAdmin } from '@/lib/supabase/server';
import { httpGet, httpPost } from '@/lib/http';
import { fetchPage } from '@/lib/fetch-page';
import { detectAts, atsListUrl, parseAtsJobs, atsHomeUrl, fetchWorkday, CAREERS_WORDS, type AtsType } from '@/lib/ats';
export const maxDuration = 300;

/**
 * Find where each company advertises its own jobs.
 *
 * Costs nothing in model calls: the vendor of a careers page gives itself away in the HTML, and
 * once we know the vendor we can usually read the board as JSON instead of crawling it. The
 * result is recorded either way, including "none_found", so a second run does not repeat the
 * search on a company that plainly has no board.
 *
 *   POST /api/jobs/careers-discovery?batch=25&recheck=1&only=aker
 *
 * Staffing agencies are skipped: their vacancies are their business, not a signal about ours.
 */
const authorised = (req: Request) => {
  const s = process.env.CRON_SECRET;
  return !!s && (req.headers.get('x-cron-secret') === s || req.headers.get('authorization') === `Bearer ${s}`);
};

export const GET = (req: Request) => run(req);
export const POST = (req: Request) => run(req);

/** Careers links on a page, best candidate first. */
function careersLinks($: cheerio.CheerioAPI, base: string): string[] {
  let origin = '';
  try { origin = new URL(base).origin; } catch { return []; }
  const scored: { href: string; score: number }[] = [];
  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href') ?? '';
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    let u: URL;
    try { u = new URL(raw, base); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    const inHref = CAREERS_WORDS.test(u.pathname) || CAREERS_WORDS.test(u.hostname);
    const inText = CAREERS_WORDS.test(text);
    if (!inHref && !inText) return;
    u.hash = '';
    // Prefer the company's own site, then short paths, then link text that says so.
    const score = (u.origin === origin ? 4 : 0) + (inHref ? 2 : 0) + (inText ? 1 : 0) - u.pathname.split('/').filter(Boolean).length * 0.3;
    scored.push({ href: u.toString(), score });
  });
  const seen = new Set<string>();
  return scored.sort((a, b) => b.score - a.score).map((s) => s.href).filter((h) => !seen.has(h) && seen.add(h)).slice(0, 6);
}

async function discover(company: { domain: string }) {
  const home = `https://${company.domain}`;
  let needsBrowser = false;

  const read = async (url: string): Promise<{ html: string; url: string } | null> => {
    const r = await httpGet(url, {}, 15000);
    if (r.ok && r.body && r.body.length > 500) return { html: r.body, url: r.url || url };
    const rendered = await fetchPage(url, { force: 'browser' });
    if (rendered.status !== 'live') return null;
    needsBrowser = true;
    // fetchPage gives text and links rather than HTML; rebuild enough for the ATS patterns.
    return { html: `${rendered.text}\n${rendered.links.join('\n')}`, url: rendered.url };
  };

  const first = await read(home);
  if (!first) return { careers_status: 'unreachable' as const, careers_needs_browser: needsBrowser };

  // The ATS may be linked straight from the homepage.
  let ats = detectAts(first.html);
  let careersUrl: string | null = null;

  if (!ats) {
    const $ = cheerio.load(first.html);
    for (const link of careersLinks($, first.url)) {
      const page = await read(link);
      if (!page) continue;
      careersUrl = careersUrl ?? page.url;
      ats = detectAts(page.html);
      if (ats) { careersUrl = page.url; break; }
      // A page that lists several jobs is a board even without a recognised vendor.
      const $$ = cheerio.load(page.html);
      const jobish = $$('a[href]').filter((_, el) => /\/(job|jobs|vacancy|vacature|stilling|stelle|offre)s?\//i.test($$(el).attr('href') ?? '')).length;
      if (jobish >= 3) { careersUrl = page.url; break; }
    }
  }

  if (ats) {
    // Workday answers a POST rather than a GET, so it gets its own path. It is worth the
    // special case: it is what most large industrial groups run.
    if (ats.type === 'workday') {
      const jobs = await fetchWorkday(ats.slug, async (u, body) => {
        const r = await httpPost(u, body, { 'content-type': 'application/json', accept: 'application/json' }, 20000);
        return { ok: r.ok, body: r.body };
      });
      return {
        careers_url: careersUrl ?? atsHomeUrl(ats.type, ats.slug), ats_type: ats.type, ats_slug: ats.slug,
        careers_status: 'found' as const, careers_needs_browser: jobs.length === 0 && needsBrowser,
        note: jobs.length ? `${jobs.length} jobs via Workday JSON` : 'Workday board did not answer — will be read from the page',
      };
    }

    // Prove the board before recording it: a slug scraped from a stale script tag is worse than
    // no slug, because the crawl would then read an empty board every day and report nothing.
    const list = atsListUrl(ats.type, ats.slug);
    if (list) {
      const r = await httpGet(list, { headers: { accept: 'application/json,application/xml,text/xml' } }, 15000);
      const jobs = r.ok ? parseAtsJobs(ats.type, ats.slug, r.body) : [];
      if (!r.ok || jobs.length === 0) {
        return { careers_url: careersUrl, ats_type: ats.type, ats_slug: ats.slug, careers_status: 'found' as const, careers_needs_browser: needsBrowser, note: `board answered ${r.status} with ${jobs.length} jobs — will be read from the page` };
      }
      return { careers_url: careersUrl ?? list, ats_type: ats.type, ats_slug: ats.slug, careers_status: 'found' as const, careers_needs_browser: false, note: `${jobs.length} jobs via ${ats.type} JSON` };
    }
    return { careers_url: careersUrl ?? atsHomeUrl(ats.type, ats.slug), ats_type: ats.type, ats_slug: ats.slug, careers_status: 'found' as const, careers_needs_browser: needsBrowser, note: `${ats.type}, no public JSON — read from the page` };
  }

  if (careersUrl) return { careers_url: careersUrl, careers_status: 'found' as const, careers_needs_browser: needsBrowser, note: 'careers page, no recognised ATS' };
  return { careers_status: 'none_found' as const, careers_needs_browser: needsBrowser };
}

async function pool<T>(items: T[], size: number, fn: (t: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(size, q.length) }, async () => {
    for (let it = q.shift(); it; it = q.shift()) await fn(it);
  }));
}

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const p = new URL(req.url).searchParams;
  const batch = Math.max(1, Number(p.get('batch') ?? 25));
  const recheck = p.get('recheck') === '1';
  const only = p.get('only');
  const chain = p.get('chain') !== '0';
  const batchesLeft = Number(p.get('batchesLeft') ?? 30);

  let q = db.from('companies').select('id, name, domain, ats_type')
    .not('domain', 'is', null).neq('employer_type', 'staffing_agency').order('id').limit(batch);
  if (!recheck) q = q.is('careers_checked_at', null);
  if (only) q = q.ilike('name', `%${only}%`);
  const { data: companies, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const stats = { looked: 0, found: 0, ats: 0, noneFound: 0, unreachable: 0 };
  const byAts: Record<string, number> = {};
  const examples: any[] = [];

  await pool(companies ?? [], 6, async (c: any) => {
    stats.looked++;
    try {
      const r: any = await discover(c);
      await db.from('companies').update({
        careers_url: r.careers_url ?? null, ats_type: r.ats_type ?? null, ats_slug: r.ats_slug ?? null,
        careers_status: r.careers_status, careers_needs_browser: !!r.careers_needs_browser,
        careers_checked_at: new Date().toISOString(),
      }).eq('id', c.id);
      if (r.careers_status === 'found') stats.found++;
      if (r.careers_status === 'none_found') stats.noneFound++;
      if (r.careers_status === 'unreachable') stats.unreachable++;
      if (r.ats_type) { stats.ats++; byAts[r.ats_type] = (byAts[r.ats_type] ?? 0) + 1; }
      if (r.careers_status === 'found') examples.push({ company: c.name, ats: r.ats_type ?? '—', url: r.careers_url, note: r.note });
    } catch (e: any) {
      await db.from('companies').update({ careers_status: 'unreachable', careers_checked_at: new Date().toISOString() }).eq('id', c.id);
      stats.unreachable++;
    }
  });

  const { count: remaining } = await db.from('companies').select('id', { count: 'exact', head: true })
    .not('domain', 'is', null).neq('employer_type', 'staffing_agency').is('careers_checked_at', null);

  let chained = false;
  if (chain && !only && !recheck && (remaining ?? 0) > 0 && batchesLeft > 1) {
    const u = new URL(req.url);
    u.searchParams.set('batchesLeft', String(batchesLeft - 1));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    await fetch(u.toString(), { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET! }, signal: ac.signal }).catch(() => {});
    chained = true;
  }

  console.log(`[careers-discovery] looked=${stats.looked} found=${stats.found} ats=${stats.ats} none=${stats.noneFound} unreachable=${stats.unreachable} remaining=${remaining}`);
  return NextResponse.json({ ok: true, stats, byAts, remaining, chained, examples: examples.slice(0, 20) });
}
