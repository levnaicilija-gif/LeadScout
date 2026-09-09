import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/server';
import { detectEmployerType } from '@/lib/agency-detector';
import { sectorFor } from '@/lib/sector';
import { tierFor, regionFor, countryFromText } from '@/lib/geo';
export const maxDuration = 300;

/**
 * Build the company universe. No network: everything here comes from rows we already hold.
 *
 *   POST /api/jobs/companies?mode=universe   people + existing companies -> companies
 *   POST /api/jobs/companies?mode=retag      re-tag country/sector/tier on what exists
 *
 * Directory crawls (WindEurope, Energy Cluster Denmark, Norwegian Offshore Wind, NHO, NWEA,
 * EIC, RenewableUK, OEUK, Danske Maritime, Norsk Industri, SeaEurope) are a separate job —
 * they need the network and a per-site parser.
 */
const authorised = (req: Request) => {
  const s = process.env.CRON_SECRET;
  return !!s && (req.headers.get('x-cron-secret') === s || req.headers.get('authorization') === `Bearer ${s}`);
};

export const GET = (req: Request) => run(req);
export const POST = (req: Request) => run(req);

/** Trailing legal forms carry no identity and break name matching. */
const canonical = (name: string) =>
  name.replace(/\s*\([^)]*\)/g, '')
    .replace(/[,.]?\s*\b(A\/S|ApS|AS|AB|Oy|Oyj|GmbH|mbH|BV|B\.V\.|NV|N\.V\.|Ltd|Limited|LLC|Inc|plc|PLC|S\.A\.|SA|SAS|SpA|Sp\.? z o\.o\.|SL|S\.L\.|AG|KG|Group)\b\.?/gi, '')
    .replace(/\s+/g, ' ').trim();

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const params = new URL(req.url).searchParams;
  const mode = params.get('mode') ?? 'universe';

  const { data: ws } = await db.from('workspaces').select('id').limit(1).maybeSingle();
  if (!ws) return NextResponse.json({ error: 'no workspace' }, { status: 400 });
  const workspace = ws.id as string;

  const { data: agencies } = await db.from('companies').select('name').eq('employer_type', 'staffing_agency');
  const agencyNames = (agencies ?? []).map((a) => a.name);

  const stats = { fromPeople: 0, inserted: 0, retagged: 0, skippedNonEurope: 0, alreadyKnown: 0 };

  if (mode === 'universe') {
    // Distinct employers in the attendee list, with the country most often recorded for them.
    const byName = new Map<string, { name: string; countries: Record<string, number>; ops: number }>();
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: page } = await db.from('people').select('company_name, country, ops_relevant').eq('workspace_id', workspace).range(from, from + PAGE - 1);
      if (!page || page.length === 0) break;
      for (const p of page) {
        const raw = (p.company_name ?? '').trim();
        if (!raw || raw.length < 2) continue;
        const key = canonical(raw).toLowerCase();
        if (!key) continue;
        const e = byName.get(key) ?? { name: canonical(raw), countries: {}, ops: 0 };
        const cc = (p.country ?? '').trim().toUpperCase();
        if (cc) e.countries[cc] = (e.countries[cc] ?? 0) + 1;
        if (p.ops_relevant) e.ops++;
        byName.set(key, e);
      }
      if (page.length < PAGE) break;
    }
    stats.fromPeople = byName.size;

    const { data: existing } = await db.from('companies').select('name').eq('workspace_id', workspace);
    const known = new Set((existing ?? []).map((c) => canonical(c.name).toLowerCase()));

    const rows: any[] = [];
    for (const [key, e] of byName) {
      if (known.has(key)) { stats.alreadyKnown++; continue; }
      const cc = Object.entries(e.countries).sort((a, b) => b[1] - a[1])[0]?.[0];
      const country = cc && cc.length === 2 ? cc : countryFromText(cc);
      const tier = tierFor(country);
      rows.push({
        workspace_id: workspace, name: e.name, country: country ?? null, region: regionFor(country), tier,
        sector: sectorFor(e.name), employer_type: detectEmployerType(e.name, agencyNames).employerType,
        source: 'WindEurope attendee list', source_url: null,
      });
      if (tier === 'outside') stats.skippedNonEurope++;
    }
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from('companies').upsert(rows.slice(i, i + 500), { onConflict: 'workspace_id,name', ignoreDuplicates: true });
      if (error) return NextResponse.json({ error: `insert failed: ${error.code} ${error.message}`, stats }, { status: 500 });
    }
    stats.inserted = rows.length;
  }

  // Every company without a tag gets one — including the ones Radar created.
  const { data: untagged } = await db.from('companies').select('id, name, country, rfbt_history').eq('workspace_id', workspace).is('tier', null).limit(5000);
  for (const c of untagged ?? []) {
    const country = c.country ?? countryFromText(c.rfbt_history);
    await db.from('companies').update({
      country: country ?? null, region: regionFor(country), tier: tierFor(country), sector: sectorFor(c.name, c.rfbt_history),
    }).eq('id', c.id);
    stats.retagged++;
  }

  const { count: total } = await db.from('companies').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace);
  return NextResponse.json({ ok: true, mode, stats, totalCompanies: total });
}
