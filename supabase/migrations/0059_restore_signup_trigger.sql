-- 0059 — the sign-up trigger is restored, and asserted rather than assumed.
--
-- ============================================================================================
-- WHAT HAPPENED, 2026-09-30/10-01
-- ============================================================================================
-- Sign-up stopped working: every insert into auth.users returned GoTrue's generic
-- "Database error creating new user", for any payload, including one with no metadata at all.
-- A catalogue query then showed the cause: `on_auth_user_created` DID NOT EXIST on auth.users.
-- Nothing was listening for a new sign-up.
--
-- IT WAS NOT LOST BY A MIGRATION. Checked rather than assumed: 0058 contains no DROP of any kind,
-- and no migration in this directory drops either the trigger or handle_new_user. It was lost by a
-- statement run by hand while reverting 0058 — either a `drop function handle_new_user() cascade`,
-- where CASCADE silently takes dependent triggers with it, or a `drop trigger if exists ...` whose
-- following `create trigger` did not run.
--
-- ============================================================================================
-- THE LESSON THIS FILE EXISTS TO CARRY
-- ============================================================================================
-- `create or replace function` NEVER recreates a trigger. The two are separate objects: replacing a
-- function body leaves every trigger bound to it, and dropping the function with CASCADE removes them
-- without a word. So any migration that touches handle_new_user must RE-ASSERT the trigger, and any
-- revert written by hand must do the same. A function body is not the thing that makes sign-up work.
--
-- AND IT MUST BE VERIFIED, NOT ASSUMED. The DO block at the end raises if the trigger is absent, so
-- this migration cannot report success while leaving sign-up broken — the exact failure mode that cost
-- two hours here, where SQL ran cleanly three times and sign-up stayed broken each time.
--
-- ============================================================================================
-- WHAT THIS FILE DOES *NOT* DO
-- ============================================================================================
-- It does not reinstate 0058's industry_limit cap or its narrowed can_see_industries. Restoring
-- sign-up comes first and alone, proved by a real sign-up rather than by SQL running without error.
-- The cap returns in its own migration once that is confirmed, and that migration will carry the
-- trigger assertion below for the same reason.
--
-- Idempotent and safe to re-run.

-- ---- 1. the function, exactly 0001's body, schema-qualified ----------------------------------
-- Qualified on purpose: an unqualified `create or replace function` resolves against whatever
-- search_path the session happens to have, which is one more way to end up with the trigger pointing
-- at a function that is no longer the one being edited.
create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer
as $$
declare ws uuid;
begin
  insert into workspaces (name, slug) values (coalesce(new.raw_user_meta_data->>'agency','My agency'), lower(regexp_replace(coalesce(new.raw_user_meta_data->>'agency','ws') || '-' || left(new.id::text,6), '[^a-z0-9]+', '-', 'g'))) returning id into ws;
  insert into users (id, workspace_id, name, role) values (new.id, ws, new.raw_user_meta_data->>'name', 'senior');
  return new;
end $$;

-- ---- 2. the trigger ---------------------------------------------------------------------------
-- Dropped and recreated in ONE statement pair, in one file, so there is no window in which the drop
-- has run and the create has not. That window is how it was lost.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- 3. PROVE IT, inside the migration --------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'auth' and c.relname = 'users'
      and t.tgname = 'on_auth_user_created' and not t.tgisinternal
  ) then
    raise exception '0059 did not restore on_auth_user_created on auth.users — sign-up is still broken, do not report this migration as applied';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'handle_new_user' and p.prosecdef
  ) then
    raise exception '0059: public.handle_new_user is missing or is no longer SECURITY DEFINER';
  end if;
  raise notice '0059: on_auth_user_created is present and public.handle_new_user is SECURITY DEFINER';
end $$;
