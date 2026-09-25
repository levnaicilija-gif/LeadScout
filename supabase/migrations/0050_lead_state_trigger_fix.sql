-- 0050 — URGENT. 0049 broke every lead insert, and this is the one-line cause.
--
-- WHAT HAPPENED. 0048 added a trigger so that every new lead gets a workspace_lead_state row, and its
-- function read the lead's status to copy it across:
--
--     values (new.workspace_id, new.id, coalesce(new.status, 'new'))
--
-- 0049 then dropped leads.status. A plpgsql trigger referencing a dropped field does not fail at drop
-- time — it fails on the next INSERT, with:
--
--     42703  record "new" has no field "status"
--
-- So from the moment 0049 applied, NO LEAD COULD BE INSERTED AT ALL. The Radar crawl, the job-post
-- crawl and the TED award ingest all save leads, and every one of them was refused. Nothing was lost
-- that was already stored, and no read was affected — the app reads workspace_lead_state and was fine
-- — but the crawl could not write. Found 2026-09-25 by inserting a lead with no status and watching it
-- refuse, minutes after 0049 was applied.
--
-- WHY 0049's OWN CHECKS DID NOT CATCH IT, which is the lesson worth keeping. Before dropping, 0049
-- checked indexes, check constraints, RLS policies, and functions that READ the columns — and found
-- and fixed two real index problems that way. What it did not check was a function that references a
-- column through a TRIGGER RECORD. `new.status` appears in no catalogue dependency that a column drop
-- consults: Postgres will not refuse the drop, will not warn, and plpgsql resolves the field only when
-- the trigger runs. A dependency search that looks for the column name in pg_depend cannot see it.
-- GREP THE MIGRATIONS FOR `new.<column>` AND `old.<column>` BEFORE DROPPING A COLUMN. One grep would
-- have found this; exactly one line in the whole tree matched.
--
-- THE FIX: the trigger stops reading the lead's status, because there is no longer any status on a
-- lead to read. workspace_lead_state.status carries `default 'new'` and NOT NULL from 0048, so leaving
-- the column out of the insert gives precisely what the old coalesce gave — 'new' — and the row is
-- created the same way it always was. The status of a lead is now, correctly, something only the state
-- table has an opinion about.
create or replace function public.lead_state_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.workspace_id is not null then
    -- status is deliberately absent: it defaults to 'new' and is NOT NULL (0048). A lead has no status
    -- of its own any more, so there is nothing here to copy.
    insert into workspace_lead_state (workspace_id, lead_id)
    values (new.workspace_id, new.id)
    on conflict (workspace_id, lead_id) do nothing;
  end if;
  return new;
end $$;

revoke all on function public.lead_state_row() from public, anon, authenticated;

-- The trigger itself is unchanged and still bound to this function; recreated only so a database
-- rebuilt from these migrations is in the same state as the one running now.
drop trigger if exists leads_state_row on leads;
create trigger leads_state_row after insert on leads
  for each row execute function public.lead_state_row();

-- ---- proved by inserting a lead, not by reading the function's text ------------------------------
-- The whole failure was that the function LOOKED correct and only failed when it ran. So this inserts
-- a real lead into a throwaway workspace, checks the state row appeared with status 'new', and removes
-- everything. If the trigger is still broken the insert raises and the migration stops here.
do $$
-- v_ prefixes on purpose: `lead_id` is also a column on workspace_lead_state, and a plpgsql variable
-- sharing a column's name makes `where lead_id = lead_id` silently true for every row.
declare v_ws uuid; v_co uuid; v_lead uuid; got text; n integer;
begin
  insert into workspaces (name, slug) values ('0050 Trigger Proof', '0050-trigger-proof-' || substr(md5(random()::text), 1, 8))
    returning id into v_ws;
  insert into companies (workspace_id, name) values (v_ws, '0050 Trigger Proof Co') returning id into v_co;

  insert into leads (workspace_id, company_id, kind, project_name)
    values (v_ws, v_co, 'won_work', '0050 Trigger Proof') returning id into v_lead;

  select s.status into got from workspace_lead_state s
   where s.workspace_id = v_ws and s.lead_id = v_lead;

  if got is null then
    raise exception '0050: the lead was inserted but no state row appeared — the trigger did not fire';
  end if;
  if got <> 'new' then
    raise exception '0050: the state row was created with status %, not new', got;
  end if;

  delete from workspace_lead_state where workspace_id = v_ws;
  delete from leads where workspace_id = v_ws;
  delete from companies where workspace_id = v_ws;
  delete from workspaces where id = v_ws;

  select count(*) into n from workspaces where id = v_ws;
  if n > 0 then raise exception '0050: the proof workspace was not removed'; end if;

  raise notice '0050: a lead inserts again, and its state row is created with status new';
end $$;
