import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * One workspace's activity on a lead or a company — the private half of item 20.
 *
 * A record being shared shares only its FACTS. Confirm, Pursue, Not-for-us, notes and the job
 * description are what ONE customer decided, and leaving them on `leads` and `companies` when those
 * become shared at step 3 would tell every customer what every other customer is working on.
 *
 * ONE PLACE, because this is exactly the kind of rule that drifts when each caller spells it out —
 * the same reason `documentPath` and `findOrCreateCompany` are single helpers.
 *
 * WHY THE LEAD TABLE IS TOTAL AND THE COMPANY TABLE IS SPARSE. `leads.status` is FILTERED IN SQL
 * inside `openLeads`, the one closure the table, both source counts and every chip number pass
 * through, so its state must be joinable — a sparse table would drop every untouched lead from an
 * inner join. 0048 therefore gives every lead a row and a trigger keeps it that way. Nothing filters
 * on a company's state in a paginated query (one crawl-side lookup and one queue filter, both
 * redirected here), so `workspace_company_state` stays sparse: a row means somebody did something.
 *
 * READS GO THROUGH THE EMBED, NOT THROUGH A SECOND QUERY. Merging in memory would break the counts
 * that CLAUDE.md warns about by name.
 */

const LEAD_STATE_COLS = 'status, confirmed_by, confirmed_at, notes, job_description, jd_version, updated_at, updated_by';

/**
 * The embed a lead LIST joins, so status and the rest come from the workspace's own row.
 *
 * `!inner`, because a list filters on status and an outer join would keep a stateless lead in the
 * results with no status to test — it would read as open whatever it is. That is why 0048 makes the
 * table total and puts a trigger on `leads`: with `!inner` a missing row means a VANISHED LEAD, which
 * is visible, rather than a lead silently treated as open, which is not.
 */
export const LEAD_STATE_EMBED = `workspace_lead_state!inner(${LEAD_STATE_COLS})`;

/**
 * The same embed as a LEFT join, for reading ONE named lead.
 *
 * Opening a lead does not filter on its status, so there is nothing to be wrong about — and turning
 * a lead whose state row is missing into a 404 would be a worse failure than showing it. Used only
 * where a single row is fetched by id.
 */
export const LEAD_STATE_LEFT = `workspace_lead_state(${LEAD_STATE_COLS})`;

/**
 * The company embed, LEFT on purpose and never `!inner`.
 *
 * `workspace_company_state` is SPARSE — a row means somebody did something, and 3 companies of 5,889
 * have one. An inner join would hide 5,886 companies. Nothing filters on a company's state inside a
 * paginated query, so nothing needs the join to be inner.
 */
export const COMPANY_STATE_LEFT = 'workspace_company_state(hiring_status, hiring_status_at, hiring_status_by, hiring_confirmed_at, hiring_confirmed_by, employer_type_override, employer_type_set_by, employer_type_set_at, employer_type_reason, notes)';

/** The embedded table's name, for building a filter key like `workspace_lead_state.status`. */
export const LEAD_STATE_TABLE = 'workspace_lead_state';

/**
 * Statuses that take a lead out of the open list, in PostgREST's `in` syntax.
 *
 * Written out ONCE because it was spelled out at nine separate call sites, and nine copies of a list
 * is how a tenth status gets added to eight of them.
 */
export const CLOSED_LEAD_STATUSES = '("stale","not_for_us")';

export type LeadStatePatch = {
  status?: string;
  confirmed_by?: string | null;
  confirmed_at?: string | null;
  notes?: string | null;
  job_description?: string | null;
  jd_version?: number | null;
};

export type CompanyStatePatch = {
  hiring_status?: string | null;
  hiring_status_at?: string | null;
  hiring_status_by?: string | null;
  hiring_confirmed_at?: string | null;
  hiring_confirmed_by?: string | null;
  employer_type_override?: string | null;
  employer_type_set_by?: string | null;
  employer_type_set_at?: string | null;
  employer_type_reason?: string | null;
  notes?: string | null;
};

/**
 * Write one workspace's state for a lead.
 *
 * An upsert, because 0048 guarantees the row exists but a lead created in the same request by a
 * path that bypasses the trigger would not have one — and a write that silently did nothing is the
 * failure shape this whole item keeps meeting. The error is RETURNED, never swallowed: the caller
 * decides what a failure means, and every caller here reads it.
 */
export async function setLeadState(
  db: SupabaseClient,
  workspaceId: string,
  leadId: string,
  patch: LeadStatePatch,
  userId?: string | null,
): Promise<{ error: string | null }> {
  const { error } = await db.from('workspace_lead_state').upsert({
    workspace_id: workspaceId,
    lead_id: leadId,
    ...patch,
    updated_at: new Date().toISOString(),
    ...(userId ? { updated_by: userId } : {}),
  }, { onConflict: 'workspace_id,lead_id' });
  return { error: error?.message ?? null };
}

/** Write one workspace's state for a company. Sparse: the row is created on first use. */
export async function setCompanyState(
  db: SupabaseClient,
  workspaceId: string,
  companyId: string,
  patch: CompanyStatePatch,
  userId?: string | null,
): Promise<{ error: string | null }> {
  const { error } = await db.from('workspace_company_state').upsert({
    workspace_id: workspaceId,
    company_id: companyId,
    ...patch,
    updated_at: new Date().toISOString(),
    ...(userId ? { updated_by: userId } : {}),
  }, { onConflict: 'workspace_id,company_id' });
  return { error: error?.message ?? null };
}

/**
 * One workspace's company state, keyed by company id.
 *
 * Read in one query for a set of companies rather than per row, and the ERROR IS RETURNED — a
 * failed read must never render as "no company has a status", which is the Candidates defect this
 * codebase already records.
 */
export async function companyStates(
  db: SupabaseClient,
  workspaceId: string,
  companyIds: string[],
): Promise<{ states: Map<string, CompanyStatePatch>; error: string | null }> {
  if (!companyIds.length) return { states: new Map(), error: null };
  const { data, error } = await db.from('workspace_company_state')
    .select('*')
    .eq('workspace_id', workspaceId)
    .in('company_id', companyIds);
  if (error) return { states: new Map(), error: error.message };
  return { states: new Map((data ?? []).map((r: any) => [r.company_id as string, r as CompanyStatePatch])), error: null };
}

/**
 * Flatten a lead row's embedded state onto the shape the screens already expect.
 *
 * The old field names are kept rather than renamed, so the ~18 places that read `lead.status` or
 * `lead.job_description` keep working. That is deliberate: a rename would have spread this step
 * across every component and drawer as well, and the field is the same FACT read from a different
 * table — not a new one.
 *
 * A row with NO state row is returned untouched, so it still shows whatever its column holds. That
 * fallback exists only between 2b and 2c; the columns go away in 2c and it goes with them.
 */
export function withLeadState<T extends Record<string, any>>(row: T): T {
  const s = Array.isArray(row.workspace_lead_state) ? row.workspace_lead_state[0] : row.workspace_lead_state;
  if (!s) return row;
  return { ...row, status: s.status, confirmed_by: s.confirmed_by, confirmed_at: s.confirmed_at, notes: s.notes, job_description: s.job_description, jd_version: s.jd_version };
}

/** The same for a company row. Sparse, so a company with no state row keeps its own columns. */
export function withCompanyState<T extends Record<string, any>>(row: T): T {
  const s = Array.isArray(row.workspace_company_state) ? row.workspace_company_state[0] : row.workspace_company_state;
  if (!s) return row;
  // THE STATE ROW IS TAKEN WHOLESALE, NULLS INCLUDED, and that is a deliberate reversal.
  //
  // While 2b dual-wrote, this skipped nulls: a sparse row created to hold a hiring status carries
  // null in employer_type_override, and letting that null win would have wiped an override the
  // COLUMN still held correctly. Once 2c removed the second write, skipping nulls inverts into the
  // opposite bug — clearing an override writes null to the state row, the null is skipped, the now
  // stale column wins, and the recruiter's clear silently comes back. A silent regression, not a
  // loud one, which is the kind this item keeps having to hunt.
  //
  // With the columns no longer written there is nothing meaningful to fall back to, so a null in the
  // state row means what it says: this workspace has no value for that field.
  return {
    ...row,
    hiring_status: s.hiring_status ?? null,
    hiring_status_at: s.hiring_status_at ?? null,
    hiring_status_by: s.hiring_status_by ?? null,
    hiring_confirmed_at: s.hiring_confirmed_at ?? null,
    hiring_confirmed_by: s.hiring_confirmed_by ?? null,
    employer_type_override: s.employer_type_override ?? null,
    employer_type_set_by: s.employer_type_set_by ?? null,
    employer_type_set_at: s.employer_type_set_at ?? null,
    // employer_type_reason is NOT taken from the state row. companies.employer_type_reason is a
    // SHARED fact the crawl writes about the DETECTED type — 525 of the 528 that carry one — and
    // overwriting it with a workspace's override reason would hide the crawl's explanation.
  };
}
