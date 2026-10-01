-- 0060 — handle_new_user gets an explicit search_path, which is why sign-up stayed broken through
--        two reverts and 0059.
--
-- ============================================================================================
-- THE CAUSE, and it was introduced by replacing a live function from the repo
-- ============================================================================================
-- handle_new_user is SECURITY DEFINER and, as written in 0001, carries NO `set search_path`. It is
-- invoked by a trigger on auth.users, by GoTrue's own role, so `insert into workspaces` and
-- `insert into users` resolve against WHATEVER search_path that session has. If the live function had a
-- `SET search_path` added at some point — Supabase's linter flags every SECURITY DEFINER function
-- without one, and applying it in the dashboard is routine — then `create or replace function` in 0058
-- DELETED it, because a replace rewrites the whole function including its options, not just its body.
--
-- That is why every attempt to fix this from the repo failed: 0058's revert, the second revert, and
-- 0059 all wrote 0001's body, and 0001's body has no search_path either. SQL ran cleanly four times and
-- sign-up stayed broken each time.
--
-- WHAT RULED EVERYTHING ELSE OUT, measured rather than assumed:
--   * GoTrue is healthy — listUsers returns the 3 real accounts.
--   * auth.users and public.users are in sync: 0 orphans, so nothing lands half-written.
--   * the payload is irrelevant: a create with NO metadata at all fails identically, and so does the
--     PUBLIC anon signUp flow ("Database error saving new user").
--   * public.users accepts writes: a direct insert with a random id fails with 23503 against
--     users_id_fkey, which is the healthy answer.
--   * the workspace path is healthy and fast: 250ms, 256 workspace_lead_state rows, 0 company-state.
--   * the trigger WAS missing (lost to a hand-run drop while reverting 0058) and 0059 restored it with
--     an assertion that would have raised — and sign-up STILL failed, which is what finally pointed
--     here: a trigger that does not exist cannot raise, so the 500 never came from the trigger at all.
--
-- ============================================================================================
-- THE RULE THIS CARRIES
-- ============================================================================================
-- NEVER REPLACE A LIVE FUNCTION FROM THE REPO WITHOUT READING ITS LIVE DEFINITION FIRST. The repo is
-- not the database: `pg_get_functiondef` is the source of truth for what is about to be overwritten,
-- and a `create or replace` carries away every option the live version had — search_path, volatility,
-- cost, leakproof — not only the body. This is the function-level form of the rule already in
-- CLAUDE.md for columns: the schema can land before the deploy, and the deploy is not the schema.
--
-- Idempotent and safe to re-run. It asserts both the search_path and the trigger at the end, so it
-- cannot report success while leaving sign-up broken.

create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer
-- THE LINE THIS MIGRATION EXISTS FOR. pg_temp last is the standard hardening: it stops a caller
-- planting a temporary object that shadows a real one inside a definer function.
set search_path = public, pg_temp
as $$
declare ws uuid;
begin
  insert into workspaces (name, slug) values (coalesce(new.raw_user_meta_data->>'agency','My agency'), lower(regexp_replace(coalesce(new.raw_user_meta_data->>'agency','ws') || '-' || left(new.id::text,6), '[^a-z0-9]+', '-', 'g'))) returning id into ws;
  insert into users (id, workspace_id, name, role) values (new.id, ws, new.raw_user_meta_data->>'name', 'senior');
  return new;
end $$;

-- The trigger is re-asserted in the same file, because a function replace never recreates one — the
-- lesson 0059 exists for, and the reason the two statements stay together.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

do $$
declare cfg text[];
begin
  select p.proconfig into cfg
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'handle_new_user';

  if cfg is null or not exists (select 1 from unnest(cfg) c where c like 'search_path=%') then
    raise exception '0060 did not set a search_path on public.handle_new_user — sign-up will stay broken';
  end if;
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'auth' and c.relname = 'users'
      and t.tgname = 'on_auth_user_created' and not t.tgisinternal
  ) then
    raise exception '0060: on_auth_user_created is missing on auth.users';
  end if;
  raise notice '0060: handle_new_user has search_path %, and on_auth_user_created is present', cfg;
end $$;
