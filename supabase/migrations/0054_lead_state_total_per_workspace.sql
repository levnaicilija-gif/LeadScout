-- 0054 — the lead state table becomes total per (WORKSPACE, LEAD), not per lead. Item 20 step 3c½.
--
-- ============================================================================================
-- THE BUG THIS FIXES, AND IT IS MINE
-- ============================================================================================
-- 0053 made leads readable across workspaces. Measured immediately afterwards, a brand-new workspace saw:
--
--     leads, direct select .................... 229    (3c working)
--     leads, via !inner workspace_lead_state ..   0    (what the Leads screen actually renders)
--     open job_posts .......................... 54
--
-- So the shared pool was invisible on the one screen it exists to fill, while Hiring now showed it —
-- because postings have no state table to join through and leads do.
--
-- WHY. 0048 made the state table total PER LEAD FOR ITS CREATING WORKSPACE: its backfill was
-- `select l.workspace_id, l.id from leads l`, and its trigger inserts `new.workspace_id`. One row per
-- lead. Every lead read goes through LEAD_STATE_EMBED, which is `!inner`, so for any workspace that did
-- not create the lead there is no row and the join drops it. At one workspace those two shapes are
-- identical, which is why it passed every check across 2b, 2c, 3a and 3b.
--
-- 0048's OWN COMMENT DESCRIBED THE RIGHT SHAPE AND I BUILT THE OTHER ONE: "rows = workspaces × leads.
-- 221 today. At ten workspaces and ten thousand leads it is 100,000 narrow rows, which Postgres does not
-- notice." That is the cross product. It is recorded here rather than quietly corrected because the
-- discrepancy survived four steps of review by being invisible until leads were actually shared.
--
-- WHY NOT A LEFT JOIN INSTEAD, which needs no rows at all: because 0048 already considered and rejected
-- it, and the reason still holds. `!inner` was chosen deliberately so a MISSING row is a VANISHED lead —
-- visible — rather than a lead silently treated as open. And a left join cannot express the filter:
-- PostgREST has no clean way to say "no state row OR status not in (…)", which 0048 states in as many
-- words. Switching to one would trade a loud failure for a silent one, in the exact place this item has
-- been bitten repeatedly.
--
-- THE COST, stated rather than hidden: rows = workspaces × leads. 2 × 229 = 458 today. Ten workspaces
-- and ten thousand leads is 100,000 narrow rows. A hundred workspaces and a hundred thousand leads is
-- ten million, which is the point at which this shape needs revisiting rather than extending — noted so
-- the ceiling is known rather than discovered.
--
-- TWO CONSEQUENCES WORTH KNOWING BEFORE THEY SURPRISE SOMEBODY:
--
--   * SIGN-UP NOW WRITES ONE ROW PER EXISTING LEAD. handle_new_user (0001) creates a workspace, so the
--     trigger below fires there: 229 inserts today, and as many as the pool holds later. That is the
--     price of a new customer seeing the pool on their first screen instead of an empty one, and it is
--     paid once per account. If the pool ever reaches a size where a sign-up feels slow, the answer is
--     to do it asynchronously rather than to go back to an empty first screen.
--   * PROBE CLEANUP KEEPS WORKING UNCHANGED, checked rather than assumed: 0047 declared both
--     workspace_id and lead_id `on delete cascade`, so deleting a throwaway workspace or a seeded lead
--     takes its state rows with it. No probe teardown needs touching, which matters because every probe
--     in the gate now creates a workspace that carries 229 of these.

-- ---- 1. every workspace gets a row for every lead -----------------------------------------------
-- The cross product, skipping what already exists. A capped workspace gets rows for leads it cannot
-- see, which costs nothing and leaks nothing: the row carries only a status, and the lead itself is
-- still filtered by can_see_industries() on the way in, so an unseeable lead stays unseeable.
insert into workspace_lead_state (workspace_id, lead_id)
select w.id, l.id
from workspaces w
cross join leads l
where l.workspace_id is not null
on conflict (workspace_id, lead_id) do nothing;

-- ---- 2. a NEW LEAD gets a row for every workspace ----------------------------------------------
-- 0048's version inserted one row, for new.workspace_id. It must now insert one per workspace, or the
-- next crawled lead is invisible to every workspace but the crawl's own — the same bug, arriving later.
create or replace function public.lead_state_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.workspace_id is not null then
    insert into workspace_lead_state (workspace_id, lead_id)
    select w.id, new.id from workspaces w
    on conflict (workspace_id, lead_id) do nothing;
  end if;
  return new;
end $$;

revoke all on function public.lead_state_row() from public, anon, authenticated;

drop trigger if exists leads_state_row on leads;
create trigger leads_state_row after insert on leads
  for each row execute function public.lead_state_row();

-- ---- 3. and a NEW WORKSPACE gets a row for every lead -------------------------------------------
-- The other half, and the one that is easy to forget: without it a customer signing up tomorrow sees an
-- empty Leads screen, which is precisely the problem item 20 exists to solve. handle_new_user (0001)
-- creates a workspace on sign-up, so this fires there.
create or replace function public.workspace_state_rows() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into workspace_lead_state (workspace_id, lead_id)
  select new.id, l.id from leads l where l.workspace_id is not null
  on conflict (workspace_id, lead_id) do nothing;
  return new;
end $$;

revoke all on function public.workspace_state_rows() from public, anon, authenticated;

drop trigger if exists workspaces_state_rows on workspaces;
create trigger workspaces_state_rows after insert on workspaces
  for each row execute function public.workspace_state_rows();

-- ============================================================================================
-- VERIFIED, AND THE INTERESTING HALF IS THE TRIGGER THAT DID NOT EXIST BEFORE
-- ============================================================================================
-- Both triggers are proved BY DOING IT — inserting a real workspace and a real lead and watching the
-- rows appear — not by reading the functions' text. 0050 is the precedent: a trigger that looked
-- correct and failed only when it ran took every lead insert down.
do $$
declare ws_n integer; lead_n integer; state_n integer; v_ws uuid; v_co uuid; v_lead uuid; got integer;
begin
  select count(*) into ws_n from workspaces;
  select count(*) into lead_n from leads where workspace_id is not null;
  select count(*) into state_n from workspace_lead_state;

  -- Total per (workspace, lead). Not "at least": a surplus would mean rows for leads that no longer
  -- exist, which the foreign key should already prevent and which would mean something else is wrong.
  if state_n <> ws_n * lead_n then
    raise exception '0054: % workspace(s) × % lead(s) = % expected, but the table holds % — it is not total per pair', ws_n, lead_n, ws_n * lead_n, state_n;
  end if;

  -- Every pair present, stated the other way round so a coincidence of counts cannot pass.
  select count(*) into got from workspaces w cross join leads l
   where l.workspace_id is not null
     and not exists (select 1 from workspace_lead_state s where s.workspace_id = w.id and s.lead_id = l.id);
  if got > 0 then raise exception '0054: % (workspace, lead) pair(s) have no state row', got; end if;

  -- ---- the workspaces trigger, proved by inserting one ----------------------------------------
  insert into workspaces (name, slug) values ('0054 Proof WS', '0054-proof-ws-' || substr(md5(random()::text), 1, 8))
    returning id into v_ws;
  select count(*) into got from workspace_lead_state where workspace_id = v_ws;
  if got <> lead_n then
    raise exception '0054: a new workspace got % state row(s) for % lead(s) — its Leads screen would be empty, which is the bug this migration exists to fix', got, lead_n;
  end if;

  -- ---- and the leads trigger, proved by inserting one -----------------------------------------
  insert into companies (workspace_id, name) values (v_ws, '0054 Proof Co') returning id into v_co;
  insert into leads (workspace_id, company_id, kind, project_name)
    values (v_ws, v_co, 'won_work', '0054 Proof Lead') returning id into v_lead;
  select count(*) into got from workspace_lead_state where lead_id = v_lead;
  if got <> ws_n + 1 then
    raise exception '0054: a new lead got % state row(s) for % workspace(s) — every workspace but its own would not see it', got, ws_n + 1;
  end if;

  -- ---- put the proof back ---------------------------------------------------------------------
  delete from workspace_lead_state where lead_id = v_lead;
  delete from workspace_lead_state where workspace_id = v_ws;
  delete from leads where id = v_lead;
  delete from companies where id = v_co;
  delete from workspaces where id = v_ws;
  if exists (select 1 from workspaces where id = v_ws) then raise exception '0054: the proof workspace was not removed'; end if;

  select count(*) into state_n from workspace_lead_state;
  if state_n <> ws_n * lead_n then
    raise exception '0054: the proof left % state row(s) behind, expected %', state_n, ws_n * lead_n;
  end if;

  raise notice '0054: % × % = % state rows, both triggers proved by insertion, proof removed', ws_n, lead_n, state_n;
end $$;
