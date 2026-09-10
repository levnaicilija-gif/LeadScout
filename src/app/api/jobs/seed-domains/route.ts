import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import * as cheerio from 'cheerio';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/server';
import { httpGet } from '@/lib/http';
import { claude, MODEL_CLASSIFY } from '@/lib/ai/claude';
import { logModelCall } from '@/lib/cost';
import { detectEmployerType } from '@/lib/agency-detector';
import { tierFor, regionFor } from '@/lib/geo';
export const maxDuration = 300;

/**
 * seeds/company_domains_from_v1.csv carries 119 domains and nothing else — no company name,
 * and marked unverified. So the name has to come from the site: fetch each homepage, read who
 * it says it is, and only then match or create a company.
 *
 *   POST /api/jobs/seed-domains?limit=40&dry=1
 *
 * A domain whose page does not identify a company — parked, dead, a directory — is rejected
 * rather than guessed at from the hostname. Staffing agencies and job boards are skipped: this
 * list is for employers.
 */
const authorised = (req: Request) => {
  const s = process.env.CRON_SECRET;
  return !!s && (req.headers.get('x-cron-secret') === s || req.headers.get('authorization') === `Bearer ${s}`);
};

export const GET = (req: Request) => run(req);
export const POST = (req: Request) => run(req);

const JOB_BOARD = /(jobindex|finn\.no|eures|werk\.nl|cv-library|reed\.co|indeed|jobnet|arbetsformedlingen|nav\.no|monster|totaljobs|glassdoor|linkedin|stepstone|jobs?\.|karriere\.|vacature)/i;

const Site = z.object({
  company: z.string().nullish().transform((v) => v ?? null),
  sector: z.enum(['offshore_wind', 'shipyard', 'oil_gas', 'epc', 'industrial', 'marine_contractor', 'om_service', 'irrelevant']).nullish().transform((v) => v ?? null),
  country: z.string().nullish().transform((v) => v ?? null),
  is_agency: z.boolean().nullish().transform((v) => v ?? false),
});

const SYSTEM = `You are reading a company's own homepage to identify it.

Return JSON only:
{"company":"the company's own name as printed on the page","sector":"offshore_wind | shipyard | oil_gas | epc | industrial | marine_contractor | om_service | irrelevant","country":"ISO-3166 alpha-2 of where it is based","is_agency":true|false}

Rules:
- company is the name the site gives itself, copied from the page — not guessed from the domain.
- If the page is parked, an error, a domain-for-sale notice, a directory or a link farm, return {"company":null}.
- is_agency is true for a staffing, recruitment, manpower or crewing business — those employ nobody directly and are not wanted here.
- sector describes what the company DOES. irrelevant covers banks, investors, law firms, consultancies, software, research, media, associations and public bodies.
- Omit country if the page does not say where the company is based.`;

const canonical = (name: string) =>
  name.replace(/\s*\([^)]*\)/g, '')
    .replace(/[,.]?\s*\b(A\/S|ApS|AS|AB|Oy|Oyj|GmbH|mbH|BV|B\.V\.|NV|N\.V\.|Ltd|Limited|LLC|Inc|plc|PLC|S\.A\.|SA|SAS|SpA|Sp\.? z o\.o\.|SL|S\.L\.|AG|KG|Group)\b\.?/gi, '')
    .replace(/\s+/g, ' ').trim();

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const p = new URL(req.url).searchParams;
  const limit = Number(p.get('limit') ?? 40);
  const dry = p.get('dry') === '1';

  const { data: ws } = await db.from('workspaces').select('id').limit(1).maybeSingle();
  if (!ws) return NextResponse.json({ error: 'no workspace' }, { status: 400 });
  const workspace = ws.id as string;

  const csvPath = path.join(process.cwd(), 'seeds', 'company_domains_from_v1.csv');
  if (!fs.existsSync(csvPath)) return NextResponse.json({ error: 'seeds/company_domains_from_v1.csv not found in the deployment' }, { status: 404 });
  const rows = parse(fs.readFileSync(csvPath), { columns: true, skip_empty_lines: true }) as any[];

  // Skip anything already carrying this domain, so a re-run only does what is left.
  const { data: haveRows } = await db.from('companies').select('domain').eq('workspace_id', workspace).not('domain', 'is', null);
  const have = new Set((haveRows ?? []).map((c) => String(c.domain).toLowerCase()));

  const byName = new Map<string, any>();
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('companies').select('id, name, domain, sector, country').eq('workspace_id', workspace).range(from, from + 999);
    if (!data || !data.length) break;
    for (const c of data) byName.set(canonical(c.name).toLowerCase(), c);
    if (data.length < 1000) break;
  }

  const { data: agencies } = await db.from('companies').select('name').eq('workspace_id', workspace).eq('employer_type', 'staffing_agency');
  const agencyNames = (agencies ?? []).map((a) => a.name);

  const stats = { looked: 0, matched: 0, created: 0, rejected: 0, skippedAgency: 0, alreadyHad: 0 };
  const rejected: { domain: string; why: string }[] = [];
  const done: any[] = [];

  for (const r of rows) {
    const domain = String(r.domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!domain) continue;
    if (have.has(domain)) { stats.alreadyHad++; continue; }
    if (JOB_BOARD.test(domain)) { stats.rejected++; rejected.push({ domain, why: 'job board, not an employer' }); continue; }
    if (stats.looked >= limit) break;
    stats.looked++;

    const url = `https://${domain}`;
    const res = await httpGet(url, {}, 20000);
    if (!res.ok) { stats.rejected++; rejected.push({ domain, why: res.error ?? `HTTP ${res.status}` }); continue; }

    const $ = cheerio.load(res.body);
    $('script, style, noscript').remove();
    const evidence = [
      `TITLE: ${$('title').first().text().trim()}`,
      `SITE NAME: ${$('meta[property="og:site_name"]').attr('content') ?? ''}`,
      `DESCRIPTION: ${$('meta[name="description"]').attr('content') ?? ''}`,
      `TEXT: ${$('body').text().replace(/\s+/g, ' ').trim().slice(0, 1500)}`,
      `FOOTER: ${$('footer').text().replace(/\s+/g, ' ').trim().slice(0, 400)}`,
    ].join('\n');

    let site: z.output<typeof Site>;
    try {
      const ai = await claude.messages.create({
        model: MODEL_CLASSIFY, max_tokens: 300, system: SYSTEM,
        messages: [{ role: 'user', content: `Domain: ${domain}\n\n${evidence}` }],
      });
      await logModelCall(db, workspace, MODEL_CLASSIFY, `seed-domain ${domain}`, ai.usage);
      const text = ai.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');
      site = Site.parse(JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}'));
    } catch (e: any) {
      stats.rejected++; rejected.push({ domain, why: `could not read the page: ${String(e?.message ?? e).slice(0, 80)}` }); continue;
    }

    if (!site.company) { stats.rejected++; rejected.push({ domain, why: 'page does not identify a company (parked, dead or a directory)' }); continue; }

    const det = detectEmployerType(site.company, agencyNames);
    if (site.is_agency || det.employerType === 'staffing_agency') { stats.skippedAgency++; continue; }
    if (site.sector === 'irrelevant') { stats.rejected++; rejected.push({ domain, why: `${site.company} — not an employer of trades` }); continue; }

    const key = canonical(site.company).toLowerCase();
    const hit = byName.get(key);
    const country = (site.country ?? '').toUpperCase().slice(0, 2) || null;

    if (hit) {
      if (!dry) await db.from('companies').update({
        domain, source_url: url, source: hit.domain ? undefined : 'LeadScout v1 domain list',
        ...(hit.sector && hit.sector !== 'other' ? {} : { sector: site.sector ?? undefined }),
        ...(hit.country ? {} : { country, region: regionFor(country), tier: tierFor(country) }),
      }).eq('id', hit.id);
      stats.matched++;
      done.push({ domain, company: site.company, action: 'matched', to: hit.name });
    } else {
      if (!dry) {
        const { error } = await db.from('companies').insert({
          workspace_id: workspace, name: site.company, domain, country,
          region: regionFor(country), tier: tierFor(country), sector: site.sector ?? 'other',
          employer_type: det.employerType, source: 'LeadScout v1 domain list', source_url: url,
        });
        if (error) { stats.rejected++; rejected.push({ domain, why: error.message.slice(0, 80) }); continue; }
      }
      stats.created++;
      done.push({ domain, company: site.company, action: 'created', sector: site.sector, country });
    }
    have.add(domain);
    byName.set(key, { id: 'new', name: site.company, domain });
  }

  const remaining = rows.length - stats.looked - stats.alreadyHad;
  return NextResponse.json({ ok: true, dry, total: rows.length, stats, remaining, done, rejected });
}
