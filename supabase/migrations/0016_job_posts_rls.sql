-- Hiring now was empty for every user, and had been since the day it was built.
--
-- 0001 gave job_posts this policy:
--
--   using (lead_id in (select id from leads where workspace_id = my_workspace()))
--
-- 0006 then made lead_id optional and made company_id the anchor, because a posting on a
-- company's own careers page has no lead behind it. The policy was never updated. Every one of
-- those postings has lead_id null, so the subquery matched nothing and RLS hid all of them.
--
-- It never showed as an error. RLS denial returns an empty result, not a failure, so the page
-- rendered "No trade postings open" over forty rows that were sitting in the table.

drop policy if exists ws_job_posts on job_posts;

create policy ws_job_posts on job_posts for all using (
  -- A posting attached to a lead, as before.
  lead_id in (select id from leads where workspace_id = my_workspace())
  -- Or one anchored on a company: careers pages and job boards both land here.
  or company_id in (select id from companies where workspace_id = my_workspace())
);

-- Same fault, same shape: the postings a board advert cannot attach to any company are visible
-- to nobody. They are evidence and belong to the workspace that read them, so they carry it.
alter table job_posts add column if not exists workspace_id uuid references workspaces(id);

update job_posts jp
   set workspace_id = coalesce(
     (select l.workspace_id from leads l where l.id = jp.lead_id),
     (select c.workspace_id from companies c where c.id = jp.company_id)
   )
 where jp.workspace_id is null;

drop policy if exists ws_job_posts on job_posts;
create policy ws_job_posts on job_posts for all using (
  workspace_id = my_workspace()
  or lead_id in (select id from leads where workspace_id = my_workspace())
  or company_id in (select id from companies where workspace_id = my_workspace())
);

create index if not exists job_posts_workspace_idx on job_posts (workspace_id, status);
