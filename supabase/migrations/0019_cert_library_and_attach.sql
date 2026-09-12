-- 0019 — the certificate library, and an audit trail for attaching a document to a person.
--
-- Two things that belong together: what a certificate means, and whose it is.

-- ---------------------------------------------------------------- attaching
-- A document can arrive before the person it belongs to exists, so attaching is a decision a
-- recruiter makes later. Record who made it and when, the same way a confirmation is recorded:
-- "this welder's ticket belongs to this welder" is exactly the claim that has to be answerable.
alter table documents add column if not exists attached_by uuid references users(id);
alter table documents add column if not exists attached_at timestamptz;
alter table documents add column if not exists attach_reason text;

create index if not exists documents_unattached_idx on documents (workspace_id) where candidate_id is null;

-- ------------------------------------------------------------- cert library
-- What a certificate means, in plain English. Shipped rows carry workspace_id null and are read
-- by every workspace; a workspace writing its own row shadows the shipped one, so a senior's
-- correction never has to be re-applied after an update, and a bad edit is undone by deleting
-- the copy rather than by remembering what the original said. Same shape as trade_cards.
create table if not exists cert_library (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id),
  body text not null,                       -- 'iso9606', 'pcn', 'cswip', 'frosio', 'gwo', …
  level text,                               -- '3.1', 'Level 2', 'III'; null = the body itself
  lang text not null default 'en',
  title text not null,
  meaning text not null,                    -- what it says
  covers text,                              -- what the holder can do
  not_covered text,                         -- what it does not cover
  who_requires text,                        -- who asks for it
  typical_validity text,                    -- "3 years", "no expiry", "employer-held"
  verification_route text,                  -- public register, issuer email, none
  trades text[] default '{}',               -- our roles it satisfies
  source text,                              -- where this text came from
  updated_by uuid references users(id),
  updated_at timestamptz default now()
);

create unique index if not exists cert_library_shipped_idx
  on cert_library (body, coalesce(level, ''), lang) where workspace_id is null;
create unique index if not exists cert_library_workspace_idx
  on cert_library (workspace_id, body, coalesce(level, ''), lang) where workspace_id is not null;

alter table cert_library enable row level security;

-- Everyone reads the shipped rows and their own workspace's; only their own workspace is
-- writable, and the shipped rows are not writable from the app at all.
drop policy if exists cert_library_read on cert_library;
create policy cert_library_read on cert_library for select
  using (workspace_id is null or workspace_id = (select workspace_id from users where id = auth.uid()));

drop policy if exists cert_library_write on cert_library;
create policy cert_library_write on cert_library for all
  using (workspace_id = (select workspace_id from users where id = auth.uid()))
  with check (workspace_id = (select workspace_id from users where id = auth.uid()));

-- ------------------------------------------------------- unrecognised certs
-- A certificate we cannot explain raises a task for a senior rather than being shown as though
-- it were understood. One row per body+level, so ten copies of the same unknown ticket are one
-- job of work and not ten.
create table if not exists cert_unknown (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) not null,
  body text not null,
  level text,
  seen_count int not null default 1,
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  example_document_id uuid references documents(id) on delete set null,
  resolved_at timestamptz,
  resolved_by uuid references users(id)
);

create unique index if not exists cert_unknown_idx on cert_unknown (workspace_id, body, coalesce(level, ''));

alter table cert_unknown enable row level security;
drop policy if exists cert_unknown_all on cert_unknown;
create policy cert_unknown_all on cert_unknown for all
  using (workspace_id = (select workspace_id from users where id = auth.uid()))
  with check (workspace_id = (select workspace_id from users where id = auth.uid()));
