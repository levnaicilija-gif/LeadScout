import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Whether a migration that the code already uses has actually been applied.
 *
 * Migrations are run by hand against the live database, so a deploy can land before its schema
 * does. Naming a column that does not exist yet fails the whole query, and PostgREST reports it
 * as an error on the select rather than an absent field — which took the Leads page and the lead
 * drawer down entirely the moment 0012 was referenced.
 *
 * So features are asked for once per process and remembered. The answer only ever goes from
 * false to true, and a page renders without the feature until it does.
 */
const known = new Map<string, boolean>();

async function probe(sb: SupabaseClient, table: string, column: string) {
  const { error } = await sb.from(table).select(column).limit(1);
  // 42703 is undefined_column; anything else (RLS, network) must not be read as "missing".
  return !(error && (error.code === '42703' || /column .* does not exist/i.test(error.message)));
}

export async function hasColumn(sb: SupabaseClient, table: string, column: string): Promise<boolean> {
  const key = `${table}.${column}`;
  const cached = known.get(key);
  if (cached === true) return true;
  const present = await probe(sb, table, column);
  if (present) known.set(key, true);
  return present;
}

/** Employer-type evidence arrives with migration 0017. */
export const hasEmployerEvidence = (sb: SupabaseClient) => hasColumn(sb, 'companies', 'employer_type_evidence');

/** Campaign columns and the doc-type additions arrive with migration 0015. */
export const hasCampaignFields = (sb: SupabaseClient) => hasColumn(sb, 'campaigns', 'site');

/** Board postings carry a poster of their own, from migration 0014. */
export const hasJobBoardFields = (sb: SupabaseClient) => hasColumn(sb, 'job_posts', 'poster_name');

/** Right-to-work fields arrive with migration 0013. */
export const hasRightToWork = (sb: SupabaseClient) => hasColumn(sb, 'candidates', 'eu_passport');
export const hasCandidateCountries = (sb: SupabaseClient) => hasColumn(sb, 'workspaces', 'candidate_countries');

/** `employer_type_override` and its companions arrive with migration 0012. */
export const hasEmployerOverride = (sb: SupabaseClient) => hasColumn(sb, 'companies', 'employer_type_override');
