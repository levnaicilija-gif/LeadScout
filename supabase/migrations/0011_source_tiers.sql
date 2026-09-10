-- Source relevance tiering, and a record of every Radar run.
--
-- 600 sources is more than a morning's crawl can hold and most of them are not about work RFBT
-- staffs. Each source is read once by Haiku and placed in a tier: priority sources are crawled
-- every morning, standard ones weekly, and the clearly irrelevant are switched off with the
-- reason kept so the decision can be argued with later.

do $$ begin
  create type source_tier as enum ('priority', 'standard', 'off');
exception when duplicate_object then null; end $$;

alter table sources add column if not exists tier source_tier;
alter table sources add column if not exists relevance int;              -- 0-100, Haiku's own score
alter table sources add column if not exists topics text[];              -- what it actually covers
alter table sources add column if not exists tier_reason text;           -- why this tier, in plain words
alter table sources add column if not exists classified_at timestamptz;
alter table sources add column if not exists classify_error text;

create index if not exists sources_tier_idx on sources (tier, last_crawled_at nulls first);

-- One row per Radar invocation, so "what happened this morning" has an answer tomorrow.
create table if not exists radar_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id),
  started_at timestamptz default now(),
  finished_at timestamptz,
  tier text, cursor int, batch int,
  tally jsonb,                 -- sources, articlesRead, leads, rejected ...
  rejected jsonb,              -- [{url, why}] — the reasons, kept
  sources_seen jsonb,          -- [{source, via, links, note}]
  error text
);
alter table radar_runs enable row level security;
drop policy if exists radar_runs_ws on radar_runs;
create policy radar_runs_ws on radar_runs for all using (workspace_id = my_workspace()) with check (workspace_id = my_workspace());
