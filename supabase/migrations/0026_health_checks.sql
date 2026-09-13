-- 0026 — the RLS sweep's results where Home can show them, and the catalogue check it could not do.
--
-- Three times a table had row level security switched on and no policy, so signed-in users read
-- nothing while every service-role job saw everything: contacts (fixed by 0022), then articles,
-- lead_articles and lead_people (0025), the last three switched on outside the migrations. The sweep
-- (src/lib/rls-sweep.ts) now runs in the release gate and nightly with the recheck cron; this keeps
-- each result so Home can say when it last passed and name any table it caught.
--
-- health_checks holds verdicts only — which tables, ok or not, when, from where. No row counts: every
-- signed-in user can read it, and per-table counts would show other workspaces' volumes.
-- Written by the service role only; there is no insert policy on purpose.

create table if not exists health_checks (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  ok boolean not null,
  source text not null check (source in ('gate', 'cron', 'manual')),
  ran_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb
);
create index if not exists health_checks_kind_ran_idx on health_checks (kind, ran_at desc);

alter table health_checks enable row level security;
drop policy if exists health_checks_read on health_checks;
create policy health_checks_read on health_checks for select to authenticated using (true);

-- Exact for the bug class, and it sees tables with no rows, which counting as a user cannot judge.
-- Callable by the service role only: the list of tables is not something a browser needs.
create or replace function public.rls_tables_without_policy()
returns table (table_name text)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select c.relname::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and c.relrowsecurity
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
   order by 1
$$;
revoke all on function public.rls_tables_without_policy() from public, anon, authenticated;
grant execute on function public.rls_tables_without_policy() to service_role;
