-- 0046 — outreach gets its own workspace, and a Hiring now approach becomes sendable.
--
-- ITEM 20 STEP 1. Several private tables inherit their scope through leads, and outreach is the one
-- that matters: its policy is "lead_id in (select id from leads where workspace_id = my_workspace())".
-- Share leads before fixing that — which step 3 does — and every workspace's drafts open silently
-- for everyone. Private tables get their own boundary BEFORE anything becomes shared, which is why
-- this is first.
--
-- AND IT IS ALREADY WRONG, TODAY, BEFORE ANYTHING IS SHARED. api/hiring/route.ts writes an approach
-- drafted from postings with a company_id and NO lead_id — the route's own comment says so: "An
-- approach written from postings has a company and no lead; one written from a lead has both." NULL
-- is never `in` anything, so such a row matches no policy at all. It is written by the service role,
-- so the insert succeeds; the send path reads it back with the SIGNED-IN client and gets nothing,
-- and answers 404 'not found'. A Hiring now approach can therefore be drafted and never sent. The
-- table holds 0 rows today so nobody has hit it, but that path has existed since 0020 (2026-09-14).
--
-- This is the THIRD instance of a class CLAUDE.md already has a heading for — "A table anchored on a
-- company needs a policy that says so": contacts kept 0001's lead-only rule until 0022, and articles
-- / lead_articles / lead_people had RLS on with no policy at all until 0025.
--
-- THE BACKFILL REFUSES RATHER THAN GUESSES. 0014 failed on live data because adding the constraint
-- was treated as the job; making the data satisfy it is the job. A row is scoped from its lead, else
-- from its company, and if any row still has neither the migration RAISES instead of leaving a null
-- behind a `not null` it is about to add, or worse, dropping the row.
--
-- THE WITH CHECK IS THE 0041 LESSON, NOT A COPY OF THE USING CLAUSE. 0040's check tested only
-- "workspace_id = my_workspace()", which a writer satisfies by putting their OWN id on the row — so
-- workspace B could attach a screening call to workspace A's candidate. The same shape here would
-- let B file a draft in B that points at A's lead. So the check also requires any lead or company
-- named on the row to be one this workspace can see.
--
-- WHEN STEP 3 SHARES leads AND companies, the two parent clauses below become true for every row
-- rather than false for other workspaces' rows. That is correct and deliberate: at that point a lead
-- IS everybody's, and the row's own workspace_id is what keeps the draft private.

alter table outreach add column if not exists workspace_id uuid references workspaces(id);

-- From the lead where there is one; otherwise from the company the approach was written from.
update outreach o set workspace_id = l.workspace_id
  from leads l where o.lead_id = l.id and o.workspace_id is null;
update outreach o set workspace_id = c.workspace_id
  from companies c where o.company_id = c.id and o.workspace_id is null;

do $$
declare n integer;
begin
  select count(*) into n from outreach where workspace_id is null;
  if n > 0 then
    raise exception '0046: % outreach row(s) belong to no lead and no company, so they cannot be scoped to a workspace. Decide what they are before this migration runs — do not let a null hide behind a not null.', n;
  end if;
end $$;

alter table outreach alter column workspace_id set not null;
create index if not exists outreach_workspace_idx on outreach (workspace_id);

-- The policy is now its own, not the lead's.
drop policy if exists ws_outreach on outreach;
create policy ws_outreach on outreach for all
  using (workspace_id = my_workspace())
  with check (
    workspace_id = my_workspace()
    and (lead_id is null or lead_id in (select id from leads where workspace_id = my_workspace()))
    and (company_id is null or company_id in (select id from companies where workspace_id = my_workspace()))
  );

comment on column outreach.workspace_id is
  'The workspace this draft belongs to. Its OWN scope, never inherited through leads (item 20 step 1) — and what makes an approach written from postings, which has a company and no lead, visible to the people who wrote it.';
