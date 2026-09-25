-- 0052 — the entitlement function. Item 20 step 3b. CALLED FROM NOTHING.
--
-- This migration adds two functions and changes no policy, no column and no row. Nothing reads them
-- yet: 3c swaps the read policies onto them, and only after 3a has been stable in production. Adding
-- them alone is therefore inert by construction — the safest possible shape for the step that decides
-- what every future customer can see.
--
-- ============================================================================================
-- WHAT IT CHECKS, AND THE ONE DECISION THAT IS EASY TO GET BACKWARDS
-- ============================================================================================
-- Owner's decision (2026-09-15, item 20): industry_follow is a database-enforced boundary for CAPPED
-- accounts — industry_limit set — which never receive rows outside their followed industries and have
-- no "show all" escape hatch. UNLIMITED accounts keep the toggle.
--
-- So the boundary is keyed on industry_limit, NOT on industry_follow. An unlimited account that has
-- chosen to follow only Offshore Wind must still be able to press ?industries=all and see everything,
-- because for them the follow is a PREFERENCE. Enforcing it in the database would silently break that
-- toggle — a filter that cannot be cleared, with nothing on screen to explain why. Every one of the
-- three live accounts is unlimited (industry_limit null, follow ['all']) as of 2026-09-25, so this is
-- also what keeps 3c from changing anything anybody can currently see.
--
-- UNCLASSIFIED ROWS STAY VISIBLE, EVEN TO A CAPPED ACCOUNT (owner's decision 2026-09-25, asserted
-- rather than inherited). Measured the same day: 5,653 of 5,893 companies carry industries = '{}', and
-- only 240 are classified. The app has always shown an unclassified row — inFollowed returns true for
-- an empty array, and Radar's SQL says `industries.ov.{…},industries.eq.{}` — so hiding them here would
-- remove 96% of the company book from a capped account. The consequence is stated plainly because it
-- cuts against the letter of the capped rule: until classification is backfilled, a capped account DOES
-- receive rows outside its followed industries. That is a blocking precondition for the first capped
-- customer, not a property of this function.
--
-- NO SESSION MEANS FALSE, which is the other thing worth getting the right way round. The service role
-- BYPASSES RLS entirely, so it never consults this function and cannot be locked out by it; the only
-- caller with no auth.uid() is an anonymous one. Returning true there would mean that at 3c a policy of
-- `can_see_industries(industries)` alone would show every lead in the pool to anon. It denies instead.
--
-- ============================================================================================
-- THE FOLLOW LIST IS NOT THE INDUSTRY LIST, AND THAT IS A DUPLICATED RULE
-- ============================================================================================
-- A follow id is not always an industry id. FOLLOW_OPTIONS (src/lib/industry.ts) offers `wind` as ONE
-- choice covering TWO industries, offshore_wind and onshore_wind; every other option maps to itself.
-- So a lead tagged offshore_wind must match a follow of ['wind'], and a plain array overlap would miss
-- it. Both wind leaves are present in real data (2026-09-25), so this is load-bearing, not theoretical.
--
-- industry_follow_leaves() does that expansion, and it is A SECOND COPY of a rule TypeScript already
-- holds — exactly the shape that drifts. It is therefore exposed rather than inlined, so that
-- scripts/entitlement-probe.ts can compare it against followedIndustries() for EVERY id 0032 allows and
-- fail the gate when the two disagree. A rule in two places needs a test that reads both.

-- ---- the expansion, pure and testable -----------------------------------------------------------
-- immutable: it depends on nothing but its argument, which is what lets the probe compare it directly.
-- 'all' is NOT handled here — it expands to {all}, which matches no industry. can_see_industries tests
-- for it first, and the probe asserts that ordering rather than trusting it.
create or replace function public.industry_follow_leaves(follow text[])
returns text[]
language sql
immutable
as $$
  select array(
    select distinct leaf
    from unnest(coalesce(follow, '{}'::text[])) as f
    cross join lateral unnest(
      case when f = 'wind' then array['offshore_wind', 'onshore_wind']::text[] else array[f]::text[] end
    ) as leaf
  )
$$;

comment on function public.industry_follow_leaves(text[]) is
  'Expand a users.industry_follow list into the industry ids it covers: "wind" covers offshore_wind and onshore_wind, every other option covers itself. A SECOND COPY of followedIndustries() in src/lib/industry-follow.ts — scripts/entitlement-probe.ts compares the two for every id 0032 allows.';

-- ---- the entitlement itself ---------------------------------------------------------------------
-- security definer with a pinned search_path, the 0003/0039 rule: it reads `users`, whose own policy
-- would otherwise apply, and 0003 exists because a policy reading its own table recursed.
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
  -- No session at all. Deny — see the header: the service role never reaches here.
  if not found then return false; end if;
  -- Unlimited: no database boundary. The follow stays a preference they can toggle.
  if lim is null then return true; end if;
  -- Capped but following everything. 0032's trigger forbids 'all' alongside a limit, so this is
  -- defensive rather than reachable; it is here because a null follow must not mean "see nothing".
  if fol is null or cardinality(fol) = 0 or 'all' = any(fol) then return true; end if;
  -- Unclassified stays visible. Owner's decision 2026-09-25; 5,653 of 5,893 companies are in this case.
  if row_industries is null or cardinality(row_industries) = 0 then return true; end if;
  -- And otherwise: does the row touch anything this account follows, wind expanded?
  return row_industries && public.industry_follow_leaves(fol);
end $$;

comment on function public.can_see_industries(text[]) is
  'Item 20 step 3b: may the CALLER see a row carrying these industries? Unlimited accounts (industry_limit null) see everything — the follow is a preference, not a boundary. Capped accounts see their followed industries plus every UNCLASSIFIED row. No session sees nothing. The service role bypasses RLS and never consults this.';

-- The 0003/0039 grant pattern exactly: revoke from public, grant to the two roles that need it.
-- authenticated NEEDS execute, because from 3c this function is evaluated inside a policy on the
-- caller's own query, and a policy calling a function the caller may not execute errors the query.
revoke execute on function public.industry_follow_leaves(text[]) from public;
grant execute on function public.industry_follow_leaves(text[]) to authenticated, service_role;
revoke execute on function public.can_see_industries(text[]) from public;
grant execute on function public.can_see_industries(text[]) to authenticated, service_role;

-- ============================================================================================
-- VERIFIED HERE, BECAUSE A PROBE CANNOT DO IT
-- ============================================================================================
-- pg_policies and pg_proc are not reachable through PostgREST (PGRST205 — only the public schema is
-- exposed), so a migration's own DO block is the only place some of this can be asserted at all. That
-- was learned on 0051, where the first version of this block asserted a pattern BOTH the old and the
-- new policy matched and would have passed while proving nothing. Every assertion below is therefore
-- two-sided: it states what must be true AND what must no longer be, or it compares against a value
-- that would differ if the function were wrong.
do $$
declare got text[]; ok boolean;
begin
  -- ---- the expansion, in both directions -------------------------------------------------------
  got := public.industry_follow_leaves(array['wind']);
  if not (got @> array['offshore_wind', 'onshore_wind'] and cardinality(got) = 2) then
    raise exception '0052: industry_follow_leaves(wind) gave % — it must cover both wind industries', got;
  end if;
  -- The other side: it must not be a pass-through. If the CASE were missing, this returns {wind},
  -- which matches no lead in the database and would hide every wind row from a capped account.
  if got @> array['wind'] then
    raise exception '0052: industry_follow_leaves(wind) still contains "wind" — the expansion did not happen and no wind row would ever match';
  end if;

  got := public.industry_follow_leaves(array['grid', 'oil_gas']);
  if not (got @> array['grid', 'oil_gas'] and cardinality(got) = 2) then
    raise exception '0052: a non-group follow must map to itself, got %', got;
  end if;

  if cardinality(public.industry_follow_leaves(null)) <> 0 then
    raise exception '0052: a null follow must expand to no industries, not to null';
  end if;

  -- ---- the entitlement, where it can be reached without a session -------------------------------
  -- auth.uid() is null inside a migration, so this is the anonymous case. It must be FALSE, and that
  -- is the assertion that matters most in this block: were it true, a 3c policy of
  -- can_see_industries(industries) alone would open the whole pool to anon.
  ok := public.can_see_industries(array['offshore_wind']);
  if ok is not false then
    raise exception '0052: can_see_industries with no session returned % — it must DENY, or 3c would expose the pool to anonymous callers', ok;
  end if;
  -- And it must deny an unclassified row too: "unclassified stays visible" is a rule about ENTITLED
  -- callers, not a bypass. If this returned true, every anonymous caller would see 5,653 companies.
  ok := public.can_see_industries('{}'::text[]);
  if ok is not false then
    raise exception '0052: can_see_industries(''{}'') with no session returned % — the unclassified rule must not bypass having a session', ok;
  end if;

  -- ---- shape: security definer and a pinned search_path ----------------------------------------
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'can_see_industries'
       and p.prosecdef and p.proconfig::text like '%search_path=public, pg_temp%'
  ) then
    raise exception '0052: can_see_industries is not security definer with a pinned search_path — it reads users, whose own policy would otherwise apply';
  end if;

  -- ---- grants: authenticated must have it, public must not -------------------------------------
  if not has_function_privilege('authenticated', 'public.can_see_industries(text[])', 'execute') then
    raise exception '0052: authenticated cannot execute can_see_industries — a policy calling it at 3c would error the caller''s query';
  end if;
  if has_function_privilege('public', 'public.can_see_industries(text[])', 'execute') then
    raise exception '0052: public can still execute can_see_industries — the 0003/0039 revoke did not take';
  end if;

  -- ---- and nothing was changed -----------------------------------------------------------------
  -- This migration adds two functions. If it altered a policy or a row, it did something it was not
  -- asked to, and the count that would show it first is the one 0048 made total.
  if (select count(*) from workspace_lead_state) <> (select count(*) from leads where workspace_id is not null) then
    raise exception '0052: lead state stopped being total — this migration must not have touched any row';
  end if;

  raise notice '0052: entitlement function in place, denying without a session, wind expanded, nothing else touched';
end $$;
