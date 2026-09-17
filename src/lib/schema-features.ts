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

/**
 * Whether a whole table exists yet. Same rule as hasColumn — only ever cached once true — but
 * PostgREST reports an unknown relation on the schema cache rather than as 42703.
 */
export async function hasTable(sb: SupabaseClient, table: string): Promise<boolean> {
  const key = `table:${table}`;
  if (known.get(key) === true) return true;
  const { error } = await sb.from(table).select('*').limit(1);
  const missing = error && (error.code === '42P01' || /relation .* does not exist|Could not find the table/i.test(error.message));
  if (!missing) known.set(key, true);
  return !missing;
}

/** The certificate library and the attach audit trail arrive with migration 0019. */
export const hasCertLibrary = (sb: SupabaseClient) => hasTable(sb, 'cert_library');
export const hasAttachTrail = (sb: SupabaseClient) => hasColumn(sb, 'documents', 'attached_by');

/** Hiring-now contacts, company outreach, row state and test marking arrive with 0020. */
export const hasPostingContact = (sb: SupabaseClient) => hasColumn(sb, 'job_posts', 'contact_name');
export const hasHiringState = (sb: SupabaseClient) => hasColumn(sb, 'companies', 'hiring_status');
export const hasCompanyOutreach = (sb: SupabaseClient) => hasColumn(sb, 'outreach', 'company_id');
export const hasTestFlag = (sb: SupabaseClient) => hasColumn(sb, 'workspaces', 'is_test');

/** Where a date came from arrives with 0021. A date found only in text is written once it exists. */
export const hasPublishedAtSource = (sb: SupabaseClient) => hasColumn(sb, 'articles', 'published_at_source');
export const hasPostedAtSource = (sb: SupabaseClient) => hasColumn(sb, 'job_posts', 'posted_at_source');

/** Item 14 arrives with 0023: Radar's verdicts, email patterns, source flags. */
export const hasRadarVerdicts = (sb: SupabaseClient) => hasTable(sb, 'radar_verdicts');
export const hasEmailPatterns = (sb: SupabaseClient) => hasTable(sb, 'company_email_patterns');
export const hasSourceFlag = (sb: SupabaseClient) => hasColumn(sb, 'leads', 'source_flag');

/** Item 17 arrives with 0024: an award notice's decision or conclusion date, as a column. */
export const hasAwardDate = (sb: SupabaseClient) => hasColumn(sb, 'articles', 'award_date');

/** 0026 keeps the RLS sweep's results (src/lib/rls-sweep.ts) where Home can show them. */
export const hasHealthChecks = (sb: SupabaseClient) => hasTable(sb, 'health_checks');

/** Item 18 part 2 arrives with 0031: industries and their evidence on leads and companies (src/lib/industry.ts). */
export const hasIndustries = (sb: SupabaseClient) => hasColumn(sb, 'leads', 'industries');

/** Item 18 part 3 arrives with 0032: what each person follows, and their entitlement (src/lib/industry-follow.ts). */
export const hasIndustryFollow = (sb: SupabaseClient) => hasColumn(sb, 'users', 'industry_follow');

/** 0033: where a company's website came from, its address check against the award notice, group or own site, lookups tried. */
export const hasDomainProvenance = (sb: SupabaseClient) => hasColumn(sb, 'companies', 'domain_lookups');

/**
 * Item 24's candidate CRM — stage, employment preference, owner, retention date, candidate_number, the sends client name
 * and candidate_placements — arrives with migration 0035. SENSITIVE PERSONAL DATA: see the note on candidates in CLAUDE.md.
 */
export const hasCandidateCrm = (sb: SupabaseClient) => hasColumn(sb, 'candidates', 'stage');

/** 0039: the daily scorecard's two tables, and the column that dates a prepared pack. */
export const hasScorecards = (sb: SupabaseClient) => hasTable(sb, 'scorecards');
export const hasSendsCreatedAt = (sb: SupabaseClient) => hasColumn(sb, 'sends', 'created_at');

/** 0040: the screening call — the questions as asked, and what the candidate said. */
export const hasScreeningCalls = (sb: SupabaseClient) => hasTable(sb, 'screening_calls');

/** 0042: when you were last here, and the follow-ups you have dealt with. */
export const hasLastSeen = (sb: SupabaseClient) => hasColumn(sb, 'users', 'last_seen_at');
export const hasFollowupResolutions = (sb: SupabaseClient) => hasTable(sb, 'followup_resolutions');
