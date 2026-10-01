-- 0061 — a new sign-up is capped at one industry, and a capped account that has not chosen yet is no
--        longer shown the whole pool. 0058's intent, rewritten to survive what 0058 got wrong.
--
-- ============================================================================================
-- WHY THIS IS 0061 AND NOT 0058
-- ============================================================================================
-- 0058 carried the same two changes and broke sign-up for two hours. The body was right; what it got
-- wrong was everything AROUND the body:
--
--   * it replaced a live SECURITY DEFINER function with a body reconstructed from 0001, and the live
--     function had a `SET search_path` that 0001 does not. `create or replace` carries away every
--     option, not only the body, so the clause was deleted — and `handle_new_user` is invoked by a
--     trigger on auth.users from GoTrue's own role, so `insert into workspaces` stopped resolving.
--     Every sign-up failed, for any payload.
--   * reverting to "0001's body" twice, and then 0059, all reproduced the fault for the same reason,
--     so SQL ran cleanly four times while sign-up stayed broken.
--   * and the trigger itself was lost on the way, to a hand-run revert that led with a DROP TRIGGER.
--
-- So this file does three things 0058 did not: it sets search_path explicitly, it re-asserts the
-- trigger in the same statement pair, and it VERIFIES all of it in a DO block that raises. A migration
-- that reports success while sign-up is broken is worse than one that fails.
--
-- ============================================================================================
-- WHAT IT CLOSES, MEASURED
-- ============================================================================================
-- A probe account created exactly as a self-signup, signed in with the ANON key so RLS decided every
-- read, saw: leads 256 of 256 (100%), companies 5,903 of 5,903, CONTACTS 88 of 88 — named people with
-- phone numbers — job_posts 122 of 122. Only `people` was private, correctly. Anyone with an email
-- address could read the whole discovery pool, and nothing ends a trial: there is no trial_ends_at,
-- plan, expires_at or is_active column anywhere.
--
-- After this: leads 0 of 256 carry no industries, so the cap bites completely on leads; and 91 named
-- contacts hang off 53 companies of which only 2 are unclassified, so with read_contacts (0053)
-- reaching its parent, 51 of the 53 become unreadable to a capped-and-unchosen account. The 5,638 of
-- 5,911 companies (95%) that carry NO industries stay visible — the owner's decision of 2026-09-25,
-- not overturned here, and the open decision item 28 records.
--
-- industry_follow IS NEITHER WRITTEN NOR READ DIFFERENTLY. The obvious fix was a starter follow value
-- so the cap had something to bite on; the owner refused it, because industry_follow records a GENUINE
-- USER CHOICE and a placeholder there is indistinguishable afterwards from something the person picked.
-- 0032's own header says "null: not chosen yet" is a meaningful state.
--
-- THERE IS NO `UPDATE` IN THIS FILE, so no account already on file can be capped by it — stronger than
-- checking by user id, because it holds by construction. Verified first: all 3 accounts carry
-- industry_limit null and 0 are capped.
--
-- Idempotent and safe to re-run.

-- ---- 1. a capped account with no choice yet sees only what is unclassified --------------------
create or replace function public.can_see_industries(row_industries text[])
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare lim int; fol text[];
begin
  select industry_limit, industry_follow into lim, fol from users where id = auth.uid();
  -- No session at all. Deny — the service role never reaches here.
  if not found then return false; end if;
  -- Unlimited: no database boundary. The follow stays a preference they can toggle.
  if lim is null then return true; end if;
  -- CAPPED AND FOLLOWING EVERYTHING is still everything. 0032's trigger forbids 'all' alongside a
  -- limit, so this stays defensive rather than reachable.
  if 'all' = any(coalesce(fol, '{}'::text[])) then return true; end if;
  -- CAPPED AND NOT YET CHOSEN. This used to return true, which is how a brand-new account read 100%
  -- of the pool. It now falls through: an unclassified row is still visible, a CLASSIFIED row is not,
  -- until the person chooses. mustChooseIndustries routes a new account to onboarding before any other
  -- screen, so the window is short — but routing is not a boundary, and what this protects is real
  -- people's phone numbers.
  if fol is null or cardinality(fol) = 0 then
    return row_industries is null or cardinality(row_industries) = 0;
  end if;
  -- Unclassified stays visible. Owner's decision 2026-09-25; 5,638 of 5,911 companies are in this case.
  if row_industries is null or cardinality(row_industries) = 0 then return true; end if;
  -- And otherwise: does the row touch anything this account follows, wind expanded?
  return row_industries && public.industry_follow_leaves(fol);
end $$;

comment on function public.can_see_industries(text[]) is
  'Item 20 step 3b, narrowed by 0061: may the CALLER see a row carrying these industries? Unlimited accounts (industry_limit null) see everything — the follow is a preference, not a boundary. A CAPPED account sees its followed industries plus every unclassified row, and a capped account that has NOT CHOSEN YET sees only the unclassified ones rather than everything. No session sees nothing. The service role bypasses RLS and never consults this.';

revoke execute on function public.can_see_industries(text[]) from public;
grant execute on function public.can_see_industries(text[]) to authenticated, service_role;

-- ---- 2. a new sign-up is capped at one industry from the moment it exists ---------------------
-- THE search_path IS THE LINE 0058 LOST. Without it this function resolves `workspaces` and `users`
-- against GoTrue's own session, and sign-up fails for every payload.
--
-- ROLE STAYS `senior` DELIBERATELY: a self-signup is alone in its workspace, so a recruiter there could
-- perform none of a senior's actions in its own workspace. That is item 9's invite flow to solve.
create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare ws uuid;
begin
  insert into workspaces (name, slug) values (coalesce(new.raw_user_meta_data->>'agency','My agency'), lower(regexp_replace(coalesce(new.raw_user_meta_data->>'agency','ws') || '-' || left(new.id::text,6), '[^a-z0-9]+', '-', 'g'))) returning id into ws;
  insert into users (id, workspace_id, name, role, industry_limit) values (new.id, ws, new.raw_user_meta_data->>'name', 'senior', 1);
  return new;
end $$;

comment on function public.handle_new_user() is
  '0001, amended by 0061: a sign-up gets its own workspace and is a senior in it, capped to one industry (industry_limit 1) so the shared pool is not readable in full by anyone with an email address. industry_follow is left NULL — it records a genuine choice and must not carry a placeholder. search_path is explicit: 0058 lost it and broke sign-up for two hours.';

-- ---- 3. the trigger, re-asserted because a function replace never recreates one ---------------
-- Dropped and created in one pair, in one file, so there is no window in which the drop has run and
-- the create has not. That window is how it was lost on 2026-09-30.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- 4. PROVE ALL OF IT, inside the migration -------------------------------------------------
do $$
declare cfg text[];
begin
  select p.proconfig into cfg
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'handle_new_user';
  if cfg is null or not exists (select 1 from unnest(cfg) c where c like 'search_path=%') then
    raise exception '0061: public.handle_new_user has NO search_path — this is the 0058 fault, sign-up would break';
  end if;

  select p.proconfig into cfg
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'can_see_industries';
  if cfg is null or not exists (select 1 from unnest(cfg) c where c like 'search_path=%') then
    raise exception '0061: public.can_see_industries has NO search_path';
  end if;

  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'auth' and c.relname = 'users'
      and t.tgname = 'on_auth_user_created' and not t.tgisinternal
  ) then
    raise exception '0061: on_auth_user_created is missing on auth.users — nothing would listen for a sign-up';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'handle_new_user' and p.prosecdef
  ) then
    raise exception '0061: public.handle_new_user is no longer SECURITY DEFINER';
  end if;

  raise notice '0061: search_path set on both functions, on_auth_user_created present, handle_new_user is SECURITY DEFINER';
end $$;
