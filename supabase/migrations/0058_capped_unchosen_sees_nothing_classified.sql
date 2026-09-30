-- 0058 — a capped account that has not chosen yet stops meaning "show it everything",
--        and a new sign-up is capped at one industry from the moment it exists.
--
-- ============================================================================================
-- WHAT WAS OPEN, MEASURED ON 2026-09-28 RATHER THAN SUSPECTED
-- ============================================================================================
-- A fresh probe account was created exactly the way a self-signup is created, signed in with the
-- ANON key so RLS decided every read, and counted what it could see:
--
--     leads       246 of   246   100%
--     companies  5903 of  5903   100%
--     contacts     88 of    88   100%     <-- named people, with emails and phone numbers
--     job_posts   122 of   122   100%
--     people        0 of 21699     0%     <-- Industry Contacts, correctly private
--
-- Anyone with an email address could read the whole discovery pool. Two facts combined to allow it:
-- handle_new_user (0001:182) inserts a sign-up as `senior` and sets NO industry_limit, and
-- can_see_industries returns true outright when industry_limit is null. Nothing ends a trial either
-- — there is no trial_ends_at, plan, expires_at or is_active column anywhere.
--
-- ============================================================================================
-- WHY THIS SHAPE, AND NOT A VALUE WRITTEN INTO industry_follow
-- ============================================================================================
-- The obvious fix was to give a new sign-up a starter industry_follow so the cap had something to
-- bite on. The owner refused it, and was right to: industry_follow records a GENUINE USER CHOICE,
-- and a placeholder written there is indistinguishable afterwards from something the person picked.
-- 0032's own header says as much — "null: not chosen yet" is a meaningful state.
--
-- So the change is in the FUNCTION, and industry_follow is neither read differently nor written at
-- all. One branch changes: a capped account whose follow is null or empty no longer short-circuits
-- to true. It falls through to the rules that already exist.
--
-- ============================================================================================
-- WHAT IT CLOSES, AND WHAT IT DELIBERATELY DOES NOT
-- ============================================================================================
-- Measured on 2026-09-29, the same day:
--   * leads:     0 of 256 carry no industries. EVERY lead is classified, so the cap bites completely.
--   * contacts:  91 named contacts hang off 53 companies, and only 2 of those companies are
--                unclassified — and read_contacts (0053) reaches its parent, so 51 of the 53 become
--                unreadable to a capped-and-unchosen account.
--   * companies: 5,638 of 5,911 (95%) carry no industries and STAY VISIBLE. That is the owner's
--                decision of 2026-09-25 — an unclassified row is never hidden — and this migration
--                does not overturn it. The residue is exactly the open decision item 28 records: an
--                empty industries array currently means "visible to everyone", which is not true of a
--                company nobody has been able to read. That decision stays open, untouched here.
--
-- 'all' = any(fol) keeps its early return: 0032's trigger already forbids 'all' under a cap, so it is
-- defensive, and removing it would change behaviour nobody asked about.
--
-- ============================================================================================
-- NOTHING EXISTING IS TOUCHED, AND THAT IS STRUCTURAL RATHER THAN CAREFUL
-- ============================================================================================
-- THERE IS NO `UPDATE` IN THIS FILE. `create or replace function` governs future calls and future
-- inserts only, so no account already on file can be capped by it — a stronger guarantee than
-- checking by user id, because it holds by construction instead of by a list that could be wrong.
-- Verified before writing: all 3 accounts (Ilija, Eli, mili) carry industry_limit null, and 0 are
-- capped, so the narrowed branch cannot change what any existing user sees today.
--
-- handle_new_user is REPLACED AS A WHOLE because it is defined exactly once, in 0001, and has never
-- been redefined — checked by grepping for its DEFINITION rather than its name, after a grep for the
-- name alone suggested 0028 and 0054 redefined it when both only mention it in comments.
--
-- APPLY BY HAND, as every migration here is. Until it is applied, scripts/entitlement-cap-probe.ts
-- exits 2 — "not judged" — rather than passing on a database that still has the old function.

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
  -- CAPPED AND NOT YET CHOSEN (0058). This used to return true, which is how a brand-new account read
  -- 100% of the pool. It now falls through: an unclassified row is still visible, and a CLASSIFIED row
  -- is not, until the person chooses. `mustChooseIndustries` sends a new account to onboarding before
  -- any other screen, so the window this governs is short — but routing is not a boundary, and the
  -- named contacts this protects are real people's phone numbers.
  if fol is null or cardinality(fol) = 0 then
    return row_industries is null or cardinality(row_industries) = 0;
  end if;
  -- Unclassified stays visible. Owner's decision 2026-09-25; 5,638 of 5,911 companies are in this case.
  if row_industries is null or cardinality(row_industries) = 0 then return true; end if;
  -- And otherwise: does the row touch anything this account follows, wind expanded?
  return row_industries && public.industry_follow_leaves(fol);
end $$;

comment on function public.can_see_industries(text[]) is
  'Item 20 step 3b, narrowed by 0058: may the CALLER see a row carrying these industries? Unlimited accounts (industry_limit null) see everything — the follow is a preference, not a boundary. A CAPPED account sees its followed industries plus every unclassified row, and a capped account that has NOT CHOSEN YET sees only the unclassified ones rather than everything. No session sees nothing. The service role bypasses RLS and never consults this.';

-- 0052 granted execute to authenticated and service_role; `create or replace` preserves privileges,
-- and they are re-asserted here for the reason 0038 gives — trusting the defaults is how a function
-- came to answer for the service role and not for the app's own key.
revoke execute on function public.can_see_industries(text[]) from public;
grant execute on function public.can_see_industries(text[]) to authenticated, service_role;

-- ---- 2. a new sign-up is capped at one industry from the moment it exists ---------------------
-- The body is 0001's, unchanged except for industry_limit. Kept whole rather than patched, because a
-- `create or replace` replaces the whole function whatever this file contains, so the file has to
-- carry every line that must survive: the workspace insert, the slug, and `senior`.
--
-- ROLE IS LEFT AS `senior` DELIBERATELY. A self-signup is alone in its workspace and has nobody above
-- it, so making it a recruiter would leave an account that cannot do a senior's actions in its own
-- workspace. That is the invite flow's problem to solve (item 9's first build step: there is no way to
-- add a junior at all), not this migration's.
create or replace function handle_new_user() returns trigger language plpgsql security definer as $$
declare ws uuid;
begin
  insert into workspaces (name, slug) values (coalesce(new.raw_user_meta_data->>'agency','My agency'), lower(regexp_replace(coalesce(new.raw_user_meta_data->>'agency','ws') || '-' || left(new.id::text,6), '[^a-z0-9]+', '-', 'g'))) returning id into ws;
  -- industry_limit 1 (0058): a new account is capped from its first read, not from whenever somebody
  -- remembers to cap it. With part 1 above, the cap now bites even before the person chooses.
  insert into users (id, workspace_id, name, role, industry_limit) values (new.id, ws, new.raw_user_meta_data->>'name', 'senior', 1);
  return new;
end $$;

comment on function handle_new_user() is
  '0001, amended by 0058: a sign-up gets its own workspace and is a senior in it, now capped to one industry (industry_limit 1) so the shared pool is not readable in full by anyone with an email address. industry_follow is left NULL — it records a genuine choice and must not carry a placeholder.';
