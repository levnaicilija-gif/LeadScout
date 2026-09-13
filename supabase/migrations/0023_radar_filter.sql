-- 0023 — queue item 14: what Radar decided about each article, email patterns, source flags.
--
-- Guarded in code (src/lib/schema-features.ts): everything works before this is applied, and
-- starts recording the moment it is.

-- ------------------------------------------------------------------ verdicts
-- One row per article Radar judged under item 14's rules. A story that fails the filter is kept
-- here with its reasons — never dropped — so what was hidden, and why, can be read back and a
-- rule can be argued with. lead_id deliberately has NO foreign key: a second relationship between
-- leads and articles-by-way-of-this-table would make PostgREST embeds ambiguous (see 0013).
create table if not exists radar_verdicts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id),
  article_id uuid not null references articles(id) on delete cascade,
  lead_id uuid,
  verdict text not null check (verdict in ('lead','low_confidence','rejected')),
  rules text[] not null default '{}',
  reason text not null,
  evidence jsonb not null default '[]'::jsonb,   -- [{id, why, evidence}]
  contacts jsonb not null default '{}'::jsonb,   -- {kept:[{name,title,rank,why}], excluded:[{name,title,rule,why}], unverified:[...]}
  company_name text,
  rules_version text not null,
  evaluated_at timestamptz not null default now(),
  is_test boolean not null default false
);
-- A partial earlier apply could hold duplicates; for a verdict the newest evaluation is the truth.
delete from radar_verdicts a using radar_verdicts b
 where a.article_id = b.article_id and (a.evaluated_at, a.id) < (b.evaluated_at, b.id);
create unique index if not exists radar_verdicts_article_uidx on radar_verdicts (article_id);
create index if not exists radar_verdicts_ws_idx on radar_verdicts (workspace_id, verdict, evaluated_at desc);
alter table radar_verdicts enable row level security;
drop policy if exists radar_verdicts_ws on radar_verdicts;
create policy radar_verdicts_ws on radar_verdicts for all using (workspace_id = my_workspace()) with check (workspace_id = my_workspace());

-- ------------------------------------------------------------- email patterns
-- The shape of a company's addresses, as observed on pages already read. Several per company are
-- allowed; each carries how often it was seen and on which pages. A pattern is never an address:
-- nothing here is sent to, and /api/outreach refuses a pattern address.
create table if not exists company_email_patterns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id),
  company_id uuid not null references companies(id) on delete cascade,
  domain text not null,
  pattern text not null check (pattern in ('first.last','f.last','flast','firstlast','first_last','first-last','first','last.first','firstl','role')),
  confidence text not null check (confidence in ('high','medium','low')),
  observed_count int not null default 0,
  corroborated_count int not null default 0,
  examples jsonb not null default '[]'::jsonb,   -- [{address, name, url, read_at}]
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  is_test boolean not null default false
);
-- Dedupe before the unique index (0014's lesson): keep the oldest, so first_seen_at stays true.
delete from company_email_patterns a using company_email_patterns b
 where a.company_id = b.company_id and a.domain = b.domain and a.pattern = b.pattern
   and (a.first_seen_at, a.id) > (b.first_seen_at, b.id);
create unique index if not exists company_email_patterns_uidx on company_email_patterns (company_id, domain, pattern);
alter table company_email_patterns enable row level security;
drop policy if exists company_email_patterns_ws on company_email_patterns;
create policy company_email_patterns_ws on company_email_patterns for all using (workspace_id = my_workspace()) with check (workspace_id = my_workspace());

-- --------------------------------------------------------------- source flags
-- What is wrong with a lead's source, said out loud instead of silently accepted. The nightly
-- recheck sets these and leaves leads.status alone: statuses are the owner's to set.
alter table leads add column if not exists source_flag text
  check (source_flag in ('ok','broken','unreachable','landing','paywall','sign_in'));
alter table leads add column if not exists source_flag_why text;
alter table leads add column if not exists source_flag_at timestamptz;
