-- 0041 — a screening call may only ever point at rows of its own workspace.
--
-- FOUND BY THE PROBE, 2026-09-17, before anything shipped: 0040's policy checked only
-- `workspace_id = my_workspace()`, which a writer satisfies simply by putting their OWN workspace id
-- on the row. Nothing checked the rows it POINTS AT. So a user in workspace B could create a
-- screening call in B, carrying B's workspace_id, whose candidate_id was a candidate of workspace A —
-- and a screening call holds what a named person said about their right to work, their certificates
-- and their rate. B could not read A's candidate, but could attach a record to them.
--
-- 0035 already got this right for candidate_placements and this is the same rule, copied rather than
-- reinvented: the workspace must be mine AND every row referenced must belong to it.
--
-- lead_id and job_post_id had the same hole and are closed here too.
--
-- Idempotent: policies are dropped by name first. It touches no row.

drop policy if exists screening_calls_own_workspace on screening_calls;

create policy screening_calls_own_workspace on screening_calls
  for all
  using (workspace_id = my_workspace())
  with check (
    workspace_id = my_workspace()
    and exists (select 1 from candidates c where c.id = candidate_id and c.workspace_id = my_workspace())
    and (lead_id is null or exists (select 1 from leads l where l.id = lead_id and l.workspace_id = my_workspace()))
    and (job_post_id is null or exists (select 1 from job_posts j where j.id = job_post_id and j.workspace_id = my_workspace()))
  );

-- The answers policy already reaches through the call for its workspace and was proven to refuse an
-- append to another workspace's call. Restated here unchanged so both policies can be read in one
-- place, and so re-running this file leaves the pair in a known state.
drop policy if exists screening_answers_through_call on screening_answers;

create policy screening_answers_through_call on screening_answers
  for all
  using (exists (select 1 from screening_calls c where c.id = call_id and c.workspace_id = my_workspace()))
  with check (exists (select 1 from screening_calls c where c.id = call_id and c.workspace_id = my_workspace()));
