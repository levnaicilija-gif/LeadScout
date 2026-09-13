-- 0022 — contacts that hang from a company are visible to that company's workspace.
--
-- Same fault as 0016 fixed for job_posts, on the next table along. 0001 gave contacts:
--
--   using (lead_id in (select id from leads where workspace_id = my_workspace()))
--
-- The organisation-page pass (item 13) stores the people it reads on a company with no lead —
-- contacts.lead_id is nullable for exactly that — so the subquery matched nothing and RLS hid
-- every one of them from every signed-in user. It never showed as an error: RLS returns an empty
-- list. All three such contacts were hidden: René Hansen (Karstensens), Ann Sæland (AIBEL) and
-- Talitha van der Vuurst (businessinwind). Karstensens' drawer showed a switchboard and no name.
--
-- The job that wrote them uses the service role, which is why they looked fine where they were
-- checked. The drawer now reads them with the service role scoped to one company as a stopgap;
-- this makes the policy itself right.

drop policy if exists ws_contacts on contacts;

create policy ws_contacts on contacts for all using (
  -- A contact on a lead, as before.
  lead_id in (select id from leads where workspace_id = my_workspace())
  -- Or one on a company: organisation pages, company contact pages.
  or company_id in (select id from companies where workspace_id = my_workspace())
);

create index if not exists contacts_company_idx on contacts (company_id);
