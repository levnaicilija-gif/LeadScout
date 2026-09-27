/**
 * The status vocabularies, in one place, because there are TWO of them and they differ by one letter.
 *
 *   a LEAD's status      'pursue'   — the lead_status ENUM (0001_schema.sql:6)
 *   a COMPANY's status   'pursued'  — a CHECK constraint on workspace_company_state.hiring_status
 *
 * THAT IS NOT A TYPO IN THIS FILE. Both are real, both are correct in their own domain, and writing either
 * one into the other's column fails: a lead given 'pursued' is rejected with 22P02 (invalid input value for
 * enum lead_status) and a company given 'pursue' violates its check constraint. Found by audit on
 * 2026-09-28 with NO live mismatch — every call site uses the right word today — so this file exists to
 * keep it that way rather than to fix a bug. The trap is ordinary: the Leads drawer's own button reads
 * "Mark pursued" while correctly sending 'pursue' (LeadDrawer.tsx), so the wrong word is the one on screen.
 *
 * WHY THE LISTS LIVE HERE AND NOT AT EACH CALL SITE. They were duplicated as literals — a hardcoded
 * ['new','pursued','not_for_us'] validating the hiring route, a six-value active list in radar-batch and
 * the same six again in a report script, and a closed-status list written as a PostgREST filter string. A
 * value added to the database in a migration reaches none of them, and nothing notices; that is the shape
 * `status-vocabulary-check` now asserts against the LIVE schema.
 *
 * ONE HALF CAN BE VERIFIED LIVE AND THE OTHER CANNOT, which is worth knowing when trusting the check.
 * PostgREST's OpenAPI document publishes an ENUM's values, so LEAD_STATUSES is checked against the real
 * database every gate. A CHECK CONSTRAINT is invisible there — `hiring_status` reads as plain `text` — so
 * HIRING_STATUSES is checked against the migration that created it. Migrations are the source of truth by
 * a hard rule in this codebase ("never the dashboard"), which is what makes that second-best check sound.
 */

/** Every value `lead_status` accepts, in the order the enum declares them. */
export const LEAD_STATUSES = [
  'new', 'pursue', 'contacted', 'replied', 'call', 'trial', 'framework', 'not_for_us', 'stale',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * A lead somebody is working. NOT a database concept — it is the six statuses between "new" and closed,
 * and radar-batch and radar-filter-report each had their own copy of this list.
 */
export const ACTIVE_LEAD_STATUSES = ['pursue', 'contacted', 'replied', 'call', 'trial', 'framework'] as const;

/**
 * A lead the recruiter has finished with. These two are what `CLOSED_LEAD_STATUSES` renders as a PostgREST
 * filter string; kept as an array here so the check can compare it against the enum rather than parse a
 * filter literal.
 */
export const CLOSED_LEAD_STATUS_LIST = ['stale', 'not_for_us'] as const;

/** Every value `workspace_company_state.hiring_status` accepts. Note 'pursued', not 'pursue'. */
export const HIRING_STATUSES = ['new', 'pursued', 'not_for_us'] as const;
export type HiringStatus = (typeof HIRING_STATUSES)[number];

/** Is this a value the lead_status enum will accept? Used to refuse a bad request before it reaches Postgres. */
export const isLeadStatus = (s: unknown): s is LeadStatus =>
  typeof s === 'string' && (LEAD_STATUSES as readonly string[]).includes(s);

/** Is this a value the hiring_status check constraint will accept? */
export const isHiringStatus = (s: unknown): s is HiringStatus =>
  typeof s === 'string' && (HIRING_STATUSES as readonly string[]).includes(s);
