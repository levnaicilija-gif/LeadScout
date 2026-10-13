-- 0062: the tender chain's KILL SWITCH and the DATABASE CLOCK (owner's decisions, 2026-10-12).
--
-- WHY A TABLE. The chain (src/lib/jobs/tender-chain.ts) spends real money every five minutes from the tick, and
-- the owner must be able to stop it WITHOUT A DEPLOY. An environment variable needs a redeploy to change; a row
-- here is one statement in the SQL editor:
--
--     update job_switches set enabled = false, note = 'why', updated_at = now() where name = 'tender-chain';
--
-- It is SEEDED OFF. The chain does nothing automatically until the owner turns it on, which is also the gate
-- between the first live proof (HOLBØLL A/S, run by hand) and draining the backlog. A missing table, a missing
-- row or an unreadable one all read as OFF in code: a switch that cannot be read must never mean "go".
--
-- WHY A CLOCK FUNCTION. cost_log.day is stamped by the DATABASE ((now() at time zone 'utc')::date, 0006), and
-- the daily cap sums one day of it. Taking "today" from the caller's own clock is how this repo has already
-- been wrong (CLAUDE.md: the local clock read stale for hours after the machine slept). db_utc_today() is the
-- same expression cost_log uses, so the chain's "today" and the rows it sums can never disagree.
--
-- Service role only, on 0027's pattern: RLS on with a service_role-only policy (a table with RLS and NO policy
-- reddens Home through 0026's rls_tables_without_policy), and every grant to signed-in roles revoked.
-- Nothing here replaces a live function or drops anything; db_utc_today is new, so there is no live definition
-- to diff against — checked with pg_get_functiondef before writing (no function of that name existed).

create table if not exists job_switches (
  name       text primary key,
  enabled    boolean not null default false,
  note       text,
  updated_at timestamptz not null default now()
);

alter table job_switches enable row level security;
drop policy if exists job_switches_service_role_only on job_switches;
create policy job_switches_service_role_only on job_switches for all to service_role using (true) with check (true);
revoke all on job_switches from anon, authenticated;
grant all on job_switches to service_role;

insert into job_switches (name, enabled, note)
values ('tender-chain', false, 'seeded OFF by 0062: turned on by the owner after the HOLBØLL proof run')
on conflict (name) do nothing;

create or replace function db_utc_today() returns date
  language sql stable
  set search_path = public, pg_temp
as $$ select (now() at time zone 'utc')::date $$;

revoke all on function db_utc_today() from public, anon, authenticated;
grant execute on function db_utc_today() to service_role;

-- Proved, not trusted: the switch row exists (seeded off; a re-run after the owner turns it on leaves it on),
-- and the clock answers the same day cost_log stamps.
do $$
begin
  if not exists (select 1 from job_switches where name = 'tender-chain') then
    raise exception '0062: the tender-chain switch row is missing';
  end if;
  if db_utc_today() <> (now() at time zone 'utc')::date then
    raise exception '0062: db_utc_today() disagrees with cost_log''s day expression';
  end if;
end $$;
