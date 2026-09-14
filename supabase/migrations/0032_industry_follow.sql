-- 0032 — item 18 part 3: the industries each person follows, and how many they may follow.
--
--   industry_follow         null: not chosen yet — a new account is sent to onboarding before any other screen.
--                           '{all}': every industry. Otherwise follow options (src/lib/industry.ts FOLLOW_OPTIONS):
--                           'wind' stands for Offshore and Onshore Wind together; the rest are the categories.
--   industry_limit          how many a person may follow; null means no cap. A placeholder for paid tiers, not tied
--                           to role: a future subscription only has to fill in the number.
--   industry_follow_set_at  when the choice was last made
--   industry_follow_set_by  who made it — the person, or a senior adjusting it for them
--
-- Everyone already on an account follows every industry and is never sent through onboarding.
--
-- Signed-in users still write nothing on users (0028). The choice is saved by /api/me/industries and
-- /api/team/industries, which read the limit from this table for the signed-in session, never from the request.
-- The trigger below enforces the same rules for any write at all — a route, a script, the service role — so a
-- request that slips past a route still cannot exceed a limit or choose "all" under one.

alter table users add column if not exists industry_follow text[];
alter table users add column if not exists industry_limit int;
alter table users add column if not exists industry_follow_set_at timestamptz;
alter table users add column if not exists industry_follow_set_by uuid references users(id) on delete set null;

update users set industry_follow = '{all}', industry_follow_set_at = now() where industry_follow is null;

alter table users drop constraint if exists users_industry_limit_positive;
alter table users add constraint users_industry_limit_positive check (industry_limit is null or industry_limit >= 1);

create or replace function public.enforce_industry_follow() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  allowed constant text[] := array[
    'all', 'wind', 'renewable_general', 'solar', 'hydrogen_ptx', 'grid', 'oil_gas', 'petrochemical',
    'marine_offshore_construction', 'fabrication_heavy_industry', 'coatings_corrosion', 'ccs', 'mining_metals',
    'data_centers', 'pharma_life_sciences', 'infrastructure_energy_services', 'other'
  ];
  n int;
begin
  if tg_op = 'UPDATE' then
    if new.industry_follow is not distinct from old.industry_follow and new.industry_limit is not distinct from old.industry_limit then
      return new;
    end if;
    if new.industry_follow is null and old.industry_follow is not null then
      raise exception 'industry_follow: a choice once made cannot be cleared' using errcode = 'check_violation';
    end if;
  end if;
  if new.industry_follow is null then
    return new;
  end if;
  n := cardinality(new.industry_follow);
  if n = 0 then
    raise exception 'industry_follow: choose at least one industry' using errcode = 'check_violation';
  end if;
  if exists (select 1 from unnest(new.industry_follow) f where not (f = any (allowed))) then
    raise exception 'industry_follow: % holds an industry that is not offered', new.industry_follow using errcode = 'check_violation';
  end if;
  if n <> (select count(distinct f) from unnest(new.industry_follow) f) then
    raise exception 'industry_follow: an industry is chosen twice' using errcode = 'check_violation';
  end if;
  if 'all' = any (new.industry_follow) then
    if n > 1 then
      raise exception 'industry_follow: "all" is a choice of its own' using errcode = 'check_violation';
    end if;
    if new.industry_limit is not null then
      raise exception 'industry_follow: "all" needs an unlimited entitlement; this account may follow %', new.industry_limit using errcode = 'check_violation';
    end if;
  elsif new.industry_limit is not null and n > new.industry_limit then
    raise exception 'industry_follow: % chosen, this account may follow %', n, new.industry_limit using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists users_industry_follow_check on users;
create trigger users_industry_follow_check
  before insert or update of industry_follow, industry_limit on users
  for each row execute function public.enforce_industry_follow();
