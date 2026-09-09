import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import { supabaseAdmin } from '@/lib/supabase/server';
import { fetchPage } from '@/lib/fetch-page';
import { httpGet } from '@/lib/http';
import { DIRECTORIES, NOT_A_MEMBER, type Directory } from '@/lib/directories';
import { detectEmployerType } from '@/lib/agency-detector';
import { sectorFor } from '@/lib/sector';
import { tierFor, regionFor } from '@/lib/geo';
export const maxDuration = 300;

/**
 * Crawl industry member directories for company DOMAINS, and add members we do not have.
 *
 *   POST /api/jobs/directories?key=nedzero        one directory
 *   POST /api/jobs/directories?status=ok          every directory known to work
 *   add &dry=1 to report matches without writing.
 *
 * A domain is only ever attached to a company whose name we can match; an unmatched member
 * becomes a new company row carrying the directory as its source. Both keep the source URL.
 */
const authorised = (req: Request) => {
  const s = process.env.CRON_SECRET;
  return !!s && (req.headers.get('x-cron-secret') === s || req.headers.get('authorization') === `Bearer ${s}`);
};

export const GET = (req: Request) => run(req);
export const POST = (req: Request) => run(req);

const canonical = (name: string) =>
  name.replace(/\s*\([^)]*\)/g, '')
    .replace(/[,.]?\s*\b(A\/S|ApS|AS|AB|Oy|Oyj|GmbH|mbH|BV|B\.V\.|NV|N\.V\.|Ltd|Limited|LLC|Inc|plc|PLC|S\.A\.|SA|SAS|SpA|Sp\.? z o\.o\.|SL|S\.L\.|AG|KG|Group)\b\.?/gi, '')
    .replace(/\s+/g, ' ').trim();

/** A hostname reduced to its brandable part, for matching against a company name. */
const hostWord = (host: string) => host.replace(/^www\./, '').split('.')[0].replace(/[-_]/g, ' ').toLowerCase();

type Member = { name: string; domain: string };

/** Anchors that leave the site are member links; the anchor's own text is the company name. */
function membersFromHtml(html: string, pageUrl: string): Member[] {
  const $ = cheerio.load(html);
  const origin = new URL(pageUrl).origin;
  const out = new Map<string, Member>();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href')!;
    let u: URL;
    try { u = new URL(href, pageUrl); } catch { return; }
    if (u.origin === origin || !/^https?:$/.test(u.protocol)) return;
    const host = u.hostname.replace(/^www\./, '');
    if (NOT_A_MEMBER.test(host)) return;
    const text = ($(a).text() || $(a).attr('title') || $(a).find('img').attr('alt') || '').replace(/\s+/g, ' ').trim();
    const name = text && text.length > 1 && text.length < 90 ? text : hostWord(host);
    if (!out.has(host)) out.set(host, { name, domain: host });
  });
  return [...out.values()];
}

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const p = new URL(req.url).searchParams;
  const dry = p.get('dry') === '1';
  const key = p.get('key');
  const wanted: Directory[] = key ? DIRECTORIES.filter((d) => d.key === key) : DIRECTORIES.filter((d) => d.status === (p.get('status') ?? 'ok'));
  if (wanted.length === 0) return NextResponse.json({ error: 'no directory matched', known: DIRECTORIES.map((d) => `${d.key}:${d.status}`) }, { status: 400 });

  const { data: ws } = await db.from('workspaces').select('id').limit(1).maybeSingle();
  if (!ws) return NextResponse.json({ error: 'no workspace' }, { status: 400 });
  const workspace = ws.id as string;

  // The universe, keyed for matching: by canonical name and by its first significant word.
  const byName = new Map<string, { id: string; name: string; domain: string | null }>();
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('companies').select('id, name, domain').eq('workspace_id', workspace).range(from, from + 999);
    if (!data || !data.length) break;
    for (const c of data) byName.set(canonical(c.name).toLowerCase(), { id: c.id, name: c.name, domain: c.domain });
    if (data.length < 1000) break;
  }

  const { data: agencies } = await db.from('companies').select('name').eq('workspace_id', workspace).eq('employer_type', 'staffing_agency');
  const agencyNames = (agencies ?? []).map((a) => a.name);

  const results: any[] = [];
  for (const d of wanted) {
    const stat = { directory: d.key, status: d.status, note: d.note, members: 0, matched: 0, domainsAdded: 0, newCompanies: 0, error: undefined as string | undefined };
    try {
      const page = await fetchPage(d.url, d.browser ? { force: 'browser' } : {});
      if (page.status !== 'live') { stat.error = `list page unreachable: ${page.note ?? 'no reason'}`; results.push(stat); continue; }

      let members: Member[] = [];
      if (d.mode === 'direct') {
        // fetchPage gives absolute hrefs but not their anchor text, so re-read the HTML for names.
        const raw = d.browser ? '' : (await httpGet(d.url)).body;
        members = raw ? membersFromHtml(raw, d.url) : page.links.filter((l) => { try { return new URL(l).origin !== new URL(d.url).origin && !NOT_A_MEMBER.test(l); } catch { return false; } }).map((l) => { const h = new URL(l).hostname.replace(/^www\./, ''); return { name: hostWord(h), domain: h }; });
      } else {
        // profile mode: each member has an internal page; the website is one hop further in.
        // offset walks a long directory across several invocations without redoing the start.
        const off = Number(p.get('offset') ?? 0);
        const all = page.links.filter((l) => d.profilePattern!.test(new URL(l).pathname)).sort();
        const profiles = all.slice(off, off + Number(p.get('max') ?? 40));
        for (const prof of profiles) {
          // Profile pages are usually plain HTML even when the list is not — try the cheap path.
          const sub = await fetchPage(prof);
          if (sub.status !== 'live') continue;
          const ext = sub.links.find((l) => { try { const u = new URL(l); return u.origin !== new URL(d.url).origin && !NOT_A_MEMBER.test(u.hostname); } catch { return false; } });
          if (ext) members.push({ name: sub.title.split(/[|–-]/)[0].trim() || hostWord(new URL(ext).hostname), domain: new URL(ext).hostname.replace(/^www\./, '') });
        }
      }
      stat.members = members.length;

      for (const m of members) {
        const k = canonical(m.name).toLowerCase();
        const hit = byName.get(k) ?? byName.get(hostWord(m.domain));
        if (hit) {
          stat.matched++;
          if (!hit.domain && !dry) {
            const { error } = await db.from('companies').update({ domain: m.domain, source_url: d.url, source: hit.domain ? undefined : d.name }).eq('id', hit.id);
            if (!error) stat.domainsAdded++;
          } else if (!hit.domain) stat.domainsAdded++;
        } else if (!dry) {
          const { error } = await db.from('companies').insert({
            workspace_id: workspace, name: m.name, domain: m.domain, country: d.country ?? null,
            region: regionFor(d.country), tier: tierFor(d.country), sector: sectorFor(m.name),
            employer_type: detectEmployerType(m.name, agencyNames).employerType, source: d.name, source_url: d.url,
          });
          if (!error) { stat.newCompanies++; byName.set(k, { id: 'new', name: m.name, domain: m.domain }); }
        } else stat.newCompanies++;
      }
    } catch (e: any) {
      stat.error = String(e?.message ?? e).slice(0, 200);
    }
    results.push(stat);
  }

  const { count: withDomain } = await db.from('companies').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace).not('domain', 'is', null);
  return NextResponse.json({ ok: true, dry, results, companiesWithDomain: withDomain });
}
