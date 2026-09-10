import type { SupabaseClient } from '@supabase/supabase-js';
import { canonCompany, canonDomain, sameCompany } from './company-identity';
import { detectEmployerType } from './agency-detector';

/**
 * The only place a company row should be created.
 *
 * Four different jobs used to insert companies — the radar crawl, the domain seed, the careers
 * crawl and the board crawl — each matching on `ilike name` or an exact string. That is how one
 * company became two: "Equinor" from an article and "Equinor ASA" from its own careers page,
 * then the vacancy written under each and a unique index that would not build.
 *
 * Matching here is the same rule the dedupe script uses, so a row that would have been merged
 * five minutes later is simply never created.
 */
export type CompanyInput = {
  workspaceId: string;
  name: string;
  domain?: string | null;
  country?: string | null;
  sector?: string | null;
  source?: string | null;
  sourceUrl?: string | null;
  agencyNames?: string[];
};

export type CompanyResult = { id: string; name: string; created: boolean; matchedOn?: string };

export async function findOrCreateCompany(db: SupabaseClient, input: CompanyInput): Promise<CompanyResult | null> {
  const name = (input.name ?? '').trim();
  if (!name || name.length < 2) return null;
  const domain = canonDomain(input.domain);
  const key = canonCompany(name);
  if (!key) return null;

  // Look only at plausible neighbours: the same canonical name, or the same domain. Anything
  // else cannot match under sameCompany, so there is no point reading it.
  const { data: byName } = await db.from('companies')
    .select('id, name, domain').eq('workspace_id', input.workspaceId)
    .ilike('name', `%${name.split(/\s+/)[0]}%`).limit(50);
  const { data: byDomain } = domain
    ? await db.from('companies').select('id, name, domain').eq('workspace_id', input.workspaceId).ilike('domain', `%${domain}%`).limit(50)
    : { data: [] as any[] };

  const seen = new Set<string>();
  for (const c of [...(byName ?? []), ...(byDomain ?? [])]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const verdict = sameCompany({ name, domain }, { name: c.name, domain: c.domain });
    if (verdict.same) {
      // Fill a gap on the existing row rather than making a second one to hold the new fact.
      const fill: Record<string, any> = {};
      if (!c.domain && domain) fill.domain = domain;
      if (Object.keys(fill).length) await db.from('companies').update(fill).eq('id', c.id);
      return { id: c.id, name: c.name, created: false, matchedOn: verdict.why };
    }
  }

  const det = detectEmployerType(name, input.agencyNames ?? []);
  const { data, error } = await db.from('companies').insert({
    workspace_id: input.workspaceId,
    name,
    domain: domain || null,
    country: input.country ?? null,
    sector: input.sector ?? null,
    employer_type: det.employerType,
    source: input.source ?? null,
    source_url: input.sourceUrl ?? null,
  }).select('id, name').single();

  // A race, or a unique constraint we did not anticipate: read back rather than fail the caller.
  if (error) {
    const { data: again } = await db.from('companies').select('id, name')
      .eq('workspace_id', input.workspaceId).ilike('name', name).maybeSingle();
    return again ? { id: again.id, name: again.name, created: false, matchedOn: 'existing row found after a failed insert' } : null;
  }
  return { id: data.id, name: data.name, created: true };
}
