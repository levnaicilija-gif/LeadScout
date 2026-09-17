-- Item 5: the screening call — the questions as they were asked, and what the candidate said.
--
-- Until now a question set lived only in React state and died with the page: no table, no column, no
-- insert anywhere in 39 migrations. So a recruiter rang someone, asked eight questions, and nothing
-- was kept but their memory.
--
-- Two tables. A call is one sitting against one job at one version; an answer is one question in it.
--
-- WHY THE QUESTION TEXT IS COPIED IN, not referenced: a JD can be rewritten (lead/route.ts bumps
-- jd_version whenever it is), and the questions are generated from the score against THAT version.
-- Keeping only a pointer would let a later rewrite silently reattribute yesterday's answers to a
-- question nobody asked. The row holds the question as asked, for good.
--
-- Applied by hand, like every other migration. Until it is, hasScreeningCalls() keeps every screen
-- exactly as it was.

create table if not exists screening_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  -- Which job this call was about. A lead or a job post, and the JD version in force at the time.
  lead_id uuid references leads(id) on delete set null,
  job_post_id uuid references job_posts(id) on delete set null,
  jd_version int,
  score_id uuid references scores(id) on delete set null,
  started_at timestamptz default now(),
  started_by uuid references users(id),
  finished_at timestamptz,
  -- Set when a recruiter's verdict changes the picture (right to work refused, a certificate
  -- confirmed). The score is NOT rewritten in place: the candidate is marked for re-score against
  -- this lead_id/jd_version pairing, and the recruiter re-runs it (owner's decision, 2026-09-16).
  needs_rescore boolean default false,
  rescore_reason text,
  is_test boolean default false
);

create table if not exists screening_answers (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references screening_calls(id) on delete cascade,
  position int not null,
  -- Frozen as asked, with what a good answer was said to sound like.
  question text not null,
  good_answer text,
  -- What kind of question this is, so the right control appears. The model labels it; the RECRUITER
  -- decides the verdict. A mislabel can only show or hide a control — it can never move a score.
  -- right_to_work is injected in code (lead/route.ts, candidate/questions), so its kind is certain.
  kind text not null default 'open' check (kind in ('right_to_work', 'certificate', 'availability', 'rate', 'open')),
  subject text,                       -- the certificate or thing named, where there is one
  -- What the candidate actually said. Stored and shown; never interpreted for scoring.
  answer text,
  -- The recruiter's own verdict, and the only thing that may mark a re-score.
  verdict text check (verdict in ('yes', 'no', 'unclear', 'confirmed', 'not_confirmed')),
  answered_at timestamptz,
  answered_by uuid references users(id),
  unique (call_id, position)
);

create index if not exists screening_calls_candidate on screening_calls (candidate_id, started_at desc);
create index if not exists screening_answers_call on screening_answers (call_id, position);

alter table screening_calls enable row level security;
alter table screening_answers enable row level security;

-- A call is workspace-scoped like every other candidate table, with a WITH CHECK so a write can
-- never place one in another workspace. Answers have no workspace of their own and are scoped
-- through their call, the way verifications are scoped through documents.
drop policy if exists screening_calls_own_workspace on screening_calls;
create policy screening_calls_own_workspace on screening_calls
  for all using (workspace_id = my_workspace()) with check (workspace_id = my_workspace());

drop policy if exists screening_answers_through_call on screening_answers;
create policy screening_answers_through_call on screening_answers
  for all using (exists (select 1 from screening_calls c where c.id = call_id and c.workspace_id = my_workspace()))
  with check (exists (select 1 from screening_calls c where c.id = call_id and c.workspace_id = my_workspace()));

grant select, insert, update, delete on screening_calls to authenticated;
grant select, insert, update, delete on screening_answers to authenticated;
grant all on screening_calls to service_role;
grant all on screening_answers to service_role;

-- 0037's delete counts every table a candidate touches and returns those counts to the deletion log.
-- screening_calls cascades from candidate_id, and screening_answers from the call — but a cascade is
-- not a count, and an audit row that does not mention them would say a deletion was complete without
-- ever having looked. Replaced here so the log keeps telling the whole truth.
create or replace function public.delete_candidate_rows(p_candidate uuid, p_workspace uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cvs uuid[];
  v_scores uuid[];
  v_docs uuid[];
  v_calls uuid[];
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
  select coalesce(array_agg(id), '{}') into v_calls from screening_calls where candidate_id = p_candidate;

  -- Counted before the cascade removes them.
  select count(*) into c from verifications where document_id = any(v_docs);             n := n || jsonb_build_object('verifications', c);
  n := n || jsonb_build_object('documents', coalesce(array_length(v_docs, 1), 0));
  n := n || jsonb_build_object('anonymized_cvs', coalesce(array_length(v_cvs, 1), 0));
  select count(*) into c from campaign_candidates where candidate_id = p_candidate;       n := n || jsonb_build_object('campaign_candidates', c);
  select count(*) into c from internal_downloads where candidate_id = p_candidate;        n := n || jsonb_build_object('internal_downloads', c);
  select count(*) into c from candidate_placements where candidate_id = p_candidate;      n := n || jsonb_build_object('candidate_placements', c);
  select count(*) into c from screening_answers where call_id = any(v_calls);             n := n || jsonb_build_object('screening_answers', c);
  n := n || jsonb_build_object('screening_calls', coalesce(array_length(v_calls, 1), 0));

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
