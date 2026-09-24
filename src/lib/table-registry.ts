/**
 * Every table in this database, and which side of the multi-tenant boundary it is on.
 *
 * Item 20 turns discovery into shared infrastructure — crawled once, visible across workspaces —
 * while candidates, CVs, Verify results and outreach stay strictly per workspace. That boundary is
 * only real if it is written down somewhere a check can read, because the failure it prevents is
 * silent: one customer's "we're pursuing this" showing up in another's list.
 *
 * FOUR BUCKETS, NOT TWO. The 2026-09-15 design split tables shared/private and classified 25 of
 * them. Auditing it on 2026-09-23 found 40 tables and two more kinds that a binary split cannot
 * describe honestly:
 *
 *   shared    crawled FACTS, one copy for everybody. A record being shared shares only its facts —
 *             never anyone's activity on it.
 *   private   one workspace's own data and its people's actions. The default for anything new.
 *   platform  shipped content that belongs to NOBODY: the glossary, the trade cards, the certificate
 *             library and bodies. All four are already 100% `workspace_id is null` on the live
 *             database, so this bucket describes what is true rather than introducing anything. A
 *             workspace row SHADOWS a platform row; it never replaces it. Deliberately not "owned by
 *             a system workspace" (owner's decision, 2026-09-23): a fake owner reintroduces exactly
 *             the `companies.rfbt_history` problem — the first customer's name welded into a table
 *             every customer uses — in a different form.
 *   service   the service role's own machinery. No signed-in user reads these at all.
 *
 * WHAT MAKES THIS MORE THAN A LIST. `scope` records HOW a table is reached, and a private table
 * reached through a SHARED parent is precisely the leak item 20's migration order exists to prevent:
 * share the parent and the child opens silently for everyone. `outreach` is that case today — it is
 * private, and its policy is "lead_id in leads where workspace = mine". table-registry-check asserts
 * it is the ONLY one, so step 1 has a precise target and a new one cannot appear unnoticed.
 */

export type Bucket = 'shared' | 'private' | 'platform' | 'service';

export type Scope =
  /** Its own workspace_id column, checked directly against my_workspace(). */
  | { by: 'workspace_id' }
  /**
   * Reached through another table — the shape that leaks when the parent becomes shared.
   * `fk` is DECLARED rather than derived: the check first guessed it from the parent's name and
   * got "companie_id" for companies and "screening_call_id" for a column actually called call_id.
   * A claim that rests on a guess is a claim that drifts.
   */
  | { by: 'parent'; through: string; fk: string }
  /** Nobody's, or the service role's: no workspace scoping at all. */
  | { by: 'none' };

export type Entry = { bucket: Bucket; scope: Scope; why: string };

export const TABLES: Record<string, Entry> = {
  // ---- shared: crawled facts, one copy for everybody --------------------------------------------
  leads: { bucket: 'shared', scope: { by: 'workspace_id' }, why: 'a discovered project. Its FACTS are shared; status, notes, confirmations and the JD move to workspace_lead_state at step 2' },
  companies: { bucket: 'shared', scope: { by: 'workspace_id' }, why: 'a company as crawled. hiring_status, overrides and rfbt_history move to workspace_company_state at step 2' },
  articles: { bucket: 'shared', scope: { by: 'none' }, why: 'the page a lead was read from. Reached through lead_articles; 471 of 1,558 back no lead and stay service-only' },
  lead_articles: { bucket: 'shared', scope: { by: 'parent', through: 'leads', fk: 'lead_id' }, why: 'which article backs which lead — a fact about the crawl' },
  lead_people: { bucket: 'shared', scope: { by: 'parent', through: 'leads', fk: 'lead_id' }, why: 'which Industry Contact is at which lead\'s company — a fact' },
  people: { bucket: 'shared', scope: { by: 'workspace_id' }, why: 'Industry Contacts from event lists (owner\'s decision: same bucket as leads)' },
  contacts: { bucket: 'shared', scope: { by: 'parent', through: 'companies', fk: 'company_id' }, why: 'a name, title, email or phone printed on a company\'s own pages, with its source' },
  company_email_patterns: { bucket: 'shared', scope: { by: 'workspace_id' }, why: 'the email shape a company uses, observed from its own site' },
  job_posts: { bucket: 'shared', scope: { by: 'workspace_id' }, why: 'an advert as crawled, with its trades and certs_required. `status` is open/closed from the crawl, not anyone\'s activity' },
  radar_verdicts: { bucket: 'shared', scope: { by: 'workspace_id' }, why: 'why the filter kept or rejected an article — a judgement about the source, not about a customer' },
  radar_runs: { bucket: 'shared', scope: { by: 'workspace_id' }, why: 'crawl telemetry. The crawl runs once for everyone, so its log is one copy' },
  sources: { bucket: 'shared', scope: { by: 'workspace_id' }, why: 'the sites the crawl reads. NOT in the 2026-09-15 design and it should have been — see the null-workspace hole in its policy' },

  // ---- private: one workspace's data and its people's actions -----------------------------------
  candidates: { bucket: 'private', scope: { by: 'workspace_id' }, why: 'a named person. Sensitive personal data' },
  documents: { bucket: 'private', scope: { by: 'workspace_id' }, why: 'their CVs, certificates and passports' },
  verifications: { bucket: 'private', scope: { by: 'parent', through: 'documents', fk: 'document_id' }, why: 'what an issuer register answered about one document' },
  anonymized_cvs: { bucket: 'private', scope: { by: 'parent', through: 'candidates', fk: 'candidate_id' }, why: 'the client version of a CV' },
  scores: { bucket: 'private', scope: { by: 'parent', through: 'candidates', fk: 'candidate_id' }, why: 'how a candidate scored against a job' },
  sends: { bucket: 'private', scope: { by: 'parent', through: 'candidates', fk: 'candidate_id' }, why: 'which client a CV went to, and when' },
  candidate_placements: { bucket: 'private', scope: { by: 'workspace_id' }, why: 'where a named person is working. One of the most sensitive rows here' },
  screening_calls: { bucket: 'private', scope: { by: 'workspace_id' }, why: 'a phone call with a named person: right to work, rate, certificates' },
  screening_answers: { bucket: 'private', scope: { by: 'parent', through: 'screening_calls', fk: 'call_id' }, why: 'what they said, in their own words' },
  campaigns: { bucket: 'private', scope: { by: 'workspace_id' }, why: 'a workspace\'s own batch of people for a client' },
  campaign_candidates: { bucket: 'private', scope: { by: 'parent', through: 'campaigns', fk: 'campaign_id' }, why: 'who travels in which group' },
  internal_downloads: { bucket: 'private', scope: { by: 'workspace_id' }, why: 'who downloaded whose internal PDF' },
  outreach: {
    bucket: 'private',
    scope: { by: 'workspace_id' },
    why: 'ITEM 20 STEP 1, DONE (0046). It was the hazard the whole order is built around — a private draft scoped "lead_id in leads where workspace = mine", so sharing leads would have opened every workspace\'s drafts. It was also already broken: an approach written from postings has a company and NO lead, and null is never `in` anything, so those rows matched no policy and /api/outreach answered 404 on a draft it had just written',
  },
  followup_resolutions: { bucket: 'private', scope: { by: 'workspace_id' }, why: 'a resolved follow-up and the note a recruiter wrote on it' },
  scorecards: { bucket: 'private', scope: { by: 'workspace_id' }, why: 'one recruiter\'s own day' },
  scorecard_targets: { bucket: 'private', scope: { by: 'workspace_id' }, why: 'what a senior set for them' },
  deletion_log: { bucket: 'private', scope: { by: 'workspace_id' }, why: 'who deleted what, in this workspace. Numbers and codes, never a name' },
  cert_unknown: { bucket: 'private', scope: { by: 'workspace_id' }, why: 'a certificate this workspace could not recognise, raised as its own task' },
  users: { bucket: 'private', scope: { by: 'workspace_id' }, why: 'the people in a workspace. 0028 revokes every signed-in write — the mechanism step 3 copies' },
  workspaces: { bucket: 'private', scope: { by: 'none' }, why: 'the workspace itself, read by its own members through my_workspace()' },
  cost_log: {
    bucket: 'private',
    scope: { by: 'workspace_id' },
    why: 'model spend. Owner\'s decision 2026-09-23: ONE table with a scope column (crawl | workspace), not two. Half its rows carry no workspace today — crawl spend under the one system cap — and the scope column is what will say so rather than a null meaning two different things',
  },

  // ---- platform: shipped content belonging to nobody ---------------------------------------------
  glossary: { bucket: 'platform', scope: { by: 'none' }, why: '88 shipped terms, all workspace_id null. A workspace row shadows one; it never replaces it' },
  trade_cards: { bucket: 'platform', scope: { by: 'none' }, why: '10 shipped trade cards, all workspace_id null' },
  cert_library: { bucket: 'platform', scope: { by: 'none' }, why: '27 shipped "how it is checked" lines, all workspace_id null. A workspace row shadows the shipped one' },
  cert_bodies: { bucket: 'platform', scope: { by: 'none' }, why: '15 shipped certificate bodies and their routes, all workspace_id null' },
  health_checks: { bucket: 'platform', scope: { by: 'none' }, why: 'the nightly RLS sweep\'s verdict. Belongs to nobody and every workspace reads it on Home' },

  // ---- service: the service role's own machinery --------------------------------------------------
  jobs: { bucket: 'service', scope: { by: 'none' }, why: '0027: the worker queue. A signed-in user must read zero rows' },
  job_ticks: { bucket: 'service', scope: { by: 'none' }, why: '0029: the crawl schedule log. A signed-in user must read zero rows' },
};

/** Tables whose shipped rows belong to nobody — asserted to be 100% workspace_id null. */
export const PLATFORM_TABLES = Object.entries(TABLES).filter(([, e]) => e.bucket === 'platform').map(([t]) => t);

/**
 * The private tables reached through a SHARED parent — the leak item 20's order exists to prevent.
 *
 * MUST BE EMPTY, permanently, since 0046 gave outreach its own workspace_id. It held exactly one
 * before that, and "exactly one" was the right assertion only while step 1 was outstanding: it named
 * the target. Now the rule is the stronger and permanent one — no private table may be reached
 * through a table that is about to become everybody's — and the gate proves step 1 stays done rather
 * than merely that it happened once.
 */
export function privateThroughShared(): { table: string; through: string }[] {
  return Object.entries(TABLES)
    .filter(([, e]) => e.bucket === 'private' && e.scope.by === 'parent' && TABLES[(e.scope as any).through]?.bucket === 'shared')
    .map(([t, e]) => ({ table: t, through: (e.scope as any).through }));
}
