-- Item 24 (2026-09-15): the candidate pool as a simple CRM — stage, employment preference, CV-sent log, placements.
--
-- SENSITIVE PERSONAL DATA. candidates, documents, sends and candidate_placements hold names, phone numbers, emails,
-- dates of birth, passports and work history. Every change to these tables gets a policy, a check as a signed-in user
-- (scripts/rls-sweep.ts) and a reason in CLAUDE.md before it ships.
--
-- Owner's decisions, recorded under item 24 in the queue: the ID shown is the plain number from the existing reference
-- sequence (RFBT-P-0004 is #4 — nothing renumbered, public /v/<code> links keep working); stages New / Screening /
-- Presented / Placed / Bench; every recruiter in the workspace sees the full pool, with a "Mine" filter.

-- ---------------------------------------------------------------- candidates
alter table candidates add column if not exists stage text not null default 'new'
  check (stage in ('new', 'screening', 'presented', 'placed', 'bench'));
alter table candidates add column if not exists stage_changed_at timestamptz;
alter table candidates add column if not exists stage_changed_by uuid references users(id) on delete set null;
alter table candidates add column if not exists employment_preference text
  check (employment_preference in ('permanent', 'contract', 'either'));
-- Where the candidate is based. Not nationality (0013 keeps that, for right to work).
alter table candidates add column if not exists country text;
-- "Mine": the recruiter who owns the candidate. Starts as whoever created the record.
alter table candidates add column if not exists owner_id uuid references users(id) on delete set null;
-- Keep-until date. The deletion policy is decided later; the field exists so it can be set and queried now.
alter table candidates add column if not exists data_retention_until date;
-- The number shown on screen: the digits of the reference code, so RFBT-P-0004 is 4. Computed, never typed, so it can
-- never disagree with the code that public links and PDF names already use. Not a unique index: numbers come from one
-- sequence, and a unique index would have to dedupe live data inside this migration.
alter table candidates add column if not exists candidate_number int
  generated always as (nullif(regexp_replace(coalesce(reference_code, ''), '\D', '', 'g'), '')::int) stored;
create index if not exists candidates_number_idx on candidates (workspace_id, candidate_number);
create index if not exists candidates_stage_idx on candidates (workspace_id, stage);

update candidates set owner_id = created_by where owner_id is null and created_by is not null;

comment on table candidates is
  'SENSITIVE PERSONAL DATA (item 24): names, contact details, date of birth, passport and right-to-work facts, work history. Every change needs a policy, rls-sweep as a signed-in user, and a note in CLAUDE.md.';

-- ---------------------------------------------------------------- CV sent: the existing sends log, extended
-- sends already records candidate, company, who sent it and when (0001) and is scoped to the workspace through the
-- candidate. A client that is not a company on file is kept by name, so the log is searchable by client either way.
alter table sends add column if not exists client_name text;
alter table sends add column if not exists note text;
create index if not exists sends_candidate_idx on sends (candidate_id, sent_at desc);

-- ---------------------------------------------------------------- placements
-- A placement is a record, not a stage label: "who is currently placed at AIBEL" is the rows for AIBEL with no end date.
create table if not exists candidate_placements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  candidate_id uuid not null references candidates(id) on delete cascade,
  company_id uuid references companies(id) on delete set null,
  client_name text not null,
  placed_on date not null,
  ended_on date,
  placed_by uuid references users(id) on delete set null,
  placed_at timestamptz not null default now(),
  note text,
  check (ended_on is null or ended_on >= placed_on)
);
create index if not exists candidate_placements_candidate_idx on candidate_placements (candidate_id, placed_on desc);
create index if not exists candidate_placements_client_idx on candidate_placements (workspace_id, lower(client_name)) where ended_on is null;

alter table candidate_placements enable row level security;
-- One expression for reading and writing, and a WITH CHECK, so a row cannot be written into another workspace.
create policy ws_candidate_placements on candidate_placements for all
  using (workspace_id = my_workspace())
  with check (workspace_id = my_workspace() and candidate_id in (select id from candidates where workspace_id = my_workspace()));

comment on table candidate_placements is
  'SENSITIVE PERSONAL DATA (item 24): where a named person works. Workspace-scoped; placed_by / placed_at record who entered it.';
