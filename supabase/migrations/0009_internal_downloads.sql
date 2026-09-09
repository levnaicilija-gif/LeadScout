-- The internal CV carries the candidate's name, phone, email and employers. Releasing it is an
-- action worth a record, in the same spirit as `sends` logging a reveal to a client.
create table if not exists internal_downloads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id),
  candidate_id uuid references candidates(id) on delete cascade,
  downloaded_by uuid references users(id),
  downloaded_at timestamptz default now()
);
create index if not exists internal_downloads_candidate_idx on internal_downloads (candidate_id, downloaded_at desc);
alter table internal_downloads enable row level security;
create policy ws_internal_downloads on internal_downloads for all using (workspace_id = my_workspace());
