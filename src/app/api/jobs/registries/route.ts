import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/server';
import { httpGet } from '@/lib/http';
export const maxDuration = 300;

/**
 * Resolve company domains and size from national business registries.
 *
 *   POST /api/jobs/registries?registry=brreg&limit=200      Norway  (open, no key)
 *   POST /api/jobs/registries?registry=companies_house      UK      (needs COMPANIES_HOUSE_KEY)
 *   POST /api/jobs/registries?registry=cvr                  Denmark (needs credentials — see below)
 *
 * Checked live on 2026-09-09:
 *   brreg           data.brreg.no/enhetsregisteret — open JSON, returns hjemmeside (website)
 *                   and antallAnsatte (employees). Everything we need, free.
 *   companies_house api.company-information.service.gov.uk — HTTP Basic with the API key as the
 *                   username. Gives company number, status and address; it does NOT publish a
 *                   website, so it fills size/identity and leaves the domain to another method.
 *   cvr             blocked without credentials: cvrapi.dk returns 403, datacvr.virk.dk sits
 *                   behind a Cloudflare challenge, and distribution.virk.dk refuses the
 *                   connection. The official route is a free system-to-system agreement with
 *                   Erhvervsstyrelsen; set CVR_USER and CVR_PASSWORD once that exists.
 */
const authorised = (req: Request) => {
  const s = process.env.CRON_SECRET;
  return !!s && (req.headers.get('x-cron-secret') === s || req.headers.get('authorization') === `Bearer ${s}`);
};

export const GET = (req: Request) => run(req);
export const POST = (req: Request) => run(req);

const RELEVANT = ['offshore_wind', 'shipyard', 'oil_gas', 'epc', 'industrial', 'marine_contractor', 'om_service'];

const sizeBand = (employees?: number | null) =>
  employees == null ? null : employees < 50 ? 'small' : employees <= 500 ? 'medium' : 'large';

/** Names differ in legal form and case; compare on the significant words only. */
const key = (s: string) =>
  s.toLowerCase()
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[,.]?\s*\b(a\/s|aps|as|ab|oy|oyj|gmbh|mbh|bv|b\.v\.|nv|ltd|limited|llc|inc|plc|s\.a\.|sa|sas|spa|sl|ag|kg|group|holding)\b\.?/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

type Hit = { name: string; domain?: string; employees?: number; registryId?: string };

/** Norway — open register, returns the website directly. */
async function brreg(name: string): Promise<Hit | undefined> {
  const r = await httpGet(`https://data.brreg.no/enhetsregisteret/api/enheter?navn=${encodeURIComponent(name)}&size=5`, { headers: { accept: 'application/json' } }, 20000);
  if (!r.ok) return undefined;
  let j: any; try { j = JSON.parse(r.body); } catch { return undefined; }
  const list: any[] = j?._embedded?.enheter ?? [];
  const want = key(name);
  const hit = list.find((e) => key(e.navn ?? '') === want) ?? (list.length === 1 ? list[0] : undefined);
  if (!hit) return undefined;
  const site = (hit.hjemmeside ?? '').trim();
  let domain: string | undefined;
  if (site) { try { domain = new URL(site.startsWith('http') ? site : `https://${site}`).hostname.replace(/^www\./, ''); } catch { /* leave unset */ } }
  return { name: hit.navn, domain, employees: hit.antallAnsatte ?? undefined, registryId: hit.organisasjonsnummer };
}

/** United Kingdom — identity and size; Companies House does not publish websites. */
async function companiesHouse(name: string): Promise<Hit | undefined> {
  const k = process.env.COMPANIES_HOUSE_KEY;
  if (!k) return undefined;
  const auth = Buffer.from(`${k}:`).toString('base64');
  const r = await httpGet(`https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(name)}&items_per_page=5`, { headers: { authorization: `Basic ${auth}`, accept: 'application/json' } }, 20000);
  if (!r.ok) return undefined;
  let j: any; try { j = JSON.parse(r.body); } catch { return undefined; }
  const want = key(name);
  const hit = (j?.items ?? []).find((e: any) => key(e.title ?? '') === want);
  if (!hit) return undefined;
  return { name: hit.title, registryId: hit.company_number };
}

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const p = new URL(req.url).searchParams;
  const registry = p.get('registry') ?? 'brreg';
  const limit = Number(p.get('limit') ?? 150);

  if (registry === 'cvr') {
    return NextResponse.json({
      ok: false, registry, reason: 'no usable CVR endpoint without credentials',
      detail: 'cvrapi.dk returns 403, datacvr.virk.dk is behind a Cloudflare challenge, distribution.virk.dk refuses the connection. Register a free system-to-system agreement with Erhvervsstyrelsen and set CVR_USER / CVR_PASSWORD.',
    }, { status: 501 });
  }
  if (registry === 'companies_house' && !process.env.COMPANIES_HOUSE_KEY) {
    return NextResponse.json({ ok: false, registry, reason: 'COMPANIES_HOUSE_KEY is not set' }, { status: 501 });
  }

  const country = registry === 'brreg' ? 'NO' : 'GB';
  const lookup = registry === 'brreg' ? brreg : companiesHouse;

  const { data: ws } = await db.from('workspaces').select('id').limit(1).maybeSingle();
  if (!ws) return NextResponse.json({ error: 'no workspace' }, { status: 400 });

  const { data: todo } = await db.from('companies')
    .select('id, name, domain, employees')
    .eq('workspace_id', ws.id).eq('country', country).in('sector', RELEVANT)
    .is('registry_checked_at', null)
    .limit(limit);

  const stats = { looked: 0, matched: 0, domains: 0, sized: 0 };
  for (const c of todo ?? []) {
    stats.looked++;
    let hit: Hit | undefined;
    try { hit = await lookup(c.name); } catch { hit = undefined; }
    const patch: any = { registry, registry_checked_at: new Date().toISOString() };
    if (hit) {
      stats.matched++;
      patch.registry_id = hit.registryId ?? null;
      if (hit.domain && !c.domain) { patch.domain = hit.domain; patch.source_url = `https://data.brreg.no/enhetsregisteret/api/enheter/${hit.registryId}`; stats.domains++; }
      if (hit.employees != null) {
        patch.employees = hit.employees;
        patch.size_band = sizeBand(hit.employees);
        patch.size_source_url = registry === 'brreg'
          ? `https://data.brreg.no/enhetsregisteret/api/enheter/${hit.registryId}`
          : `https://find-and-update.company-information.service.gov.uk/company/${hit.registryId}`;
        stats.sized++;
      }
    }
    await db.from('companies').update(patch).eq('id', c.id);
  }

  const { count: remaining } = await db.from('companies').select('id', { count: 'exact', head: true })
    .eq('workspace_id', ws.id).eq('country', country).in('sector', RELEVANT).is('registry_checked_at', null);

  return NextResponse.json({ ok: true, registry, country, stats, remaining });
}
