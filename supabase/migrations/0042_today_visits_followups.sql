-- Today, redesigned: when you were last here, and what you still owe somebody.
--
-- Two additions, both new state that genuinely did not exist. Everything else the new Today shows —
-- the queue, the scorecard counts, the lead totals, the tool counts — is read from rows already
-- there, so this migration is deliberately small.
--
-- Applied by hand, like every other migration. Until it is, hasLastSeen() and hasFollowupResolutions()
-- keep Today exactly as it was.

-- 1. WHEN YOU WERE LAST HERE.
--
-- "While you were out" needs the timestamp of the PREVIOUS visit, and nothing recorded it: users
-- carried only id, workspace_id, name, role, onboarding_day and created_at (0001), and the later
-- migrations added industry columns alone. last_seen_at is written on Today's own load and only when
-- more than 30 minutes have passed since the stored value (owner's decision, 2026-09-17) — never in
-- currentUser(), which every screen calls on every render and which would advance the value
-- continuously, collapsing the very window the card is for.
alter table users add column if not exists last_seen_at timestamptz;

-- 2. WHAT YOU RESOLVED, KEPT.
--
-- A follow-up is DERIVED, never stored: a pack sent with no reply after 3 days, or a screening
-- answer still "unclear". So there is no row to mark done — the resolution is its own record,
-- keyed on what it was about.
--
-- Resolving one must not delete or hide it (owner's decision, 2026-09-17): it stays on the
-- candidate's own activity history and only stops appearing in tomorrow's active list. So this
-- table is the history, and it records who and when and what they did — the audit shape
-- companies.hiring_confirmed_by / hiring_confirmed_at already uses.
create table if not exists followup_resolutions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  -- Which candidate's history this belongs on. A follow-up always concerns a person.
  candidate_id uuid references candidates(id) on delete cascade,
  -- What kind of follow-up, and the row it was derived from. Together these identify it, because
  -- the follow-up itself has no id of its own.
  kind text not null check (kind in ('no_reply', 'unclear_answer')),
  source_id uuid not null,
  -- What the recruiter did about it, in their own words. Optional: marking it done is enough.
  note text,
  resolved_by uuid references users(id),
  resolved_at timestamptz default now(),
  is_test boolean default false,
  -- One resolution per follow-up. Resolving twice is the same act, not two.
  unique (workspace_id, kind, source_id)
);

create index if not exists followup_resolutions_candidate on followup_resolutions (candidate_id, resolved_at desc);

alter table followup_resolutions enable row level security;

-- Workspace-scoped, and a write can never place a row in another workspace or point at another
-- workspace's candidate — the rule 0035 set for candidate_placements and 0041 had to add to
-- screening_calls after the probe found `workspace_id = my_workspace()` alone was satisfied by
-- writing your own id.
drop policy if exists followup_resolutions_own_workspace on followup_resolutions;
create policy followup_resolutions_own_workspace on followup_resolutions
  for all
  using (workspace_id = my_workspace())
  with check (
    workspace_id = my_workspace()
    and (candidate_id is null or exists (select 1 from candidates c where c.id = candidate_id and c.workspace_id = my_workspace()))
  );

grant select, insert, update, delete on followup_resolutions to authenticated;
grant all on followup_resolutions to service_role;

comment on table followup_resolutions is
  'Today: a follow-up a recruiter has dealt with. Kept as the candidate''s own history — resolving one only stops it appearing in the active list (owner''s decision 2026-09-17).';
