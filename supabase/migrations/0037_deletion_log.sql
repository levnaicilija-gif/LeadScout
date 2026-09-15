-- 0037: deleting a candidate completely, and a record that it happened (item 24 follow-up, owner's request 2026-09-15).
--
-- Deleting a candidate removes a real person's data — CVs, certificates, the CV-sent log, placements — so it is permanent,
-- a senior's action (owner's decision, checked by the route), and it leaves a record that it happened, written BEFORE
-- anything is removed. The record holds no personal data about the person deleted: their number and reference code, who
-- deleted them and when, and how many rows and files went. A deletion log that kept the name would keep the person.
--
-- Written by the service role only, after the route has checked the signed-in user is a senior of that workspace; there is
-- no insert, update or delete policy on purpose. The workspace reads its own log.

create table if not exists deletion_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  kind text not null check (kind in ('candidate', 'document')),
  subject_id uuid not null,                  -- the id of what was deleted; nothing references it afterwards
  subject_ref text not null,                 -- '#9 · RFBT-F-0009', or 'certificate frosio' — never a person's name
  deleted_by uuid references users(id) on delete set null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,                  -- null while running, and on a deletion that failed (see error)
  removed jsonb,                             -- rows per table and files per bucket actually removed
  error text
);
create index if not exists deletion_log_workspace_idx on deletion_log (workspace_id, requested_at desc);

alter table deletion_log enable row level security;
drop policy if exists deletion_log_read on deletion_log;
create policy deletion_log_read on deletion_log for select to authenticated using (workspace_id = my_workspace());

comment on table deletion_log is
  'Who deleted which candidate or document, and when (item 24 follow-up). Written by the service role before the delete runs. No personal data about the deleted person.';

-- One transaction for every row a candidate owns. Two tables reference candidates with no cascade — sends (the CV-sent
-- log, and packs prepared for a lead) and scores — so a plain delete of the candidate is refused while either has a row;
-- they go first, together with any CV-sent row pointing at this candidate's client versions or scores. Deleting the
-- candidate then cascades to documents (and through them verifications), anonymized_cvs, campaign_candidates,
-- internal_downloads and candidate_placements. cert_unknown keeps its row and loses the example document (set null).
-- Stored files are not rows: the route removes them from storage, from the paths it read before calling this.
create or replace function public.delete_candidate_rows(p_candidate uuid, p_workspace uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cvs uuid[];
  v_scores uuid[];
  v_docs uuid[];
  n jsonb := '{}'::jsonb;
  c bigint;
begin
  perform 1 from candidates where id = p_candidate and workspace_id = p_workspace for update;
  if not found then
    raise exception 'no candidate % in workspace %', p_candidate, p_workspace;
  end if;

  select coalesce(array_agg(id), '{}') into v_cvs from anonymized_cvs where candidate_id = p_candidate;
  select coalesce(array_agg(id), '{}') into v_scores from scores where candidate_id = p_candidate;
  select coalesce(array_agg(id), '{}') into v_docs from documents where candidate_id = p_candidate;

  -- Counted before the cascade removes them.
  select count(*) into c from verifications where document_id = any(v_docs);             n := n || jsonb_build_object('verifications', c);
  n := n || jsonb_build_object('documents', coalesce(array_length(v_docs, 1), 0));
  n := n || jsonb_build_object('anonymized_cvs', coalesce(array_length(v_cvs, 1), 0));
  select count(*) into c from campaign_candidates where candidate_id = p_candidate;       n := n || jsonb_build_object('campaign_candidates', c);
  select count(*) into c from internal_downloads where candidate_id = p_candidate;        n := n || jsonb_build_object('internal_downloads', c);
  select count(*) into c from candidate_placements where candidate_id = p_candidate;      n := n || jsonb_build_object('candidate_placements', c);

  delete from sends where candidate_id = p_candidate or anonymized_cv_id = any(v_cvs) or score_id = any(v_scores);
  get diagnostics c = row_count;                                                          n := n || jsonb_build_object('sends', c);
  delete from scores where candidate_id = p_candidate;
  get diagnostics c = row_count;                                                          n := n || jsonb_build_object('scores', c);
  delete from candidates where id = p_candidate and workspace_id = p_workspace;
  get diagnostics c = row_count;                                                          n := n || jsonb_build_object('candidates', c);
  return n;
end;
$$;

revoke all on function public.delete_candidate_rows(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_candidate_rows(uuid, uuid) to service_role;
