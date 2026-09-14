-- 0029 — the crawls' schedule: Supabase calls /api/jobs/tick every five minutes, and job_ticks records each tick.
--
-- Found 2026-09-14. Radar, the job-post crawl and careers discovery chained themselves over HTTP, each batch
-- calling the app for the next. Vercel caps a function calling its own deployment (outbound fetches carry the
-- caller's x-vercel-id): run by hand that morning, every Radar batch started within two seconds of the first,
-- the fifth was refused with 508 INFINITE_LOOP_DETECTED, and the job crawl's batches picked the same companies,
-- so 13 of 347 boards were crawled. Before that, from 11 September, no chain continued past its first batch.
--
-- Now nothing chains. Every five minutes pg_cron posts to /api/jobs/tick, which runs batches one after another
-- inside its own invocation (src/lib/jobs/tick.ts): Radar from 04:00 UTC until today's run is read, careers
-- discovery while any company is unchecked, the job crawl while any board is not crawled today. A request
-- started by the database is not a function calling itself. Vercel cron still calls the tick at 04:05 as a backstop.
--
-- BEFORE APPLYING, once, in the SQL editor — the value is the CRON_SECRET set in Vercel. It is kept in Vault
-- and never written in a migration:
--
--   select vault.create_secret('<the CRON_SECRET value>', 'leadscout_cron_secret');
--
-- This migration stops with an error if that secret is not there, before it changes anything.

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'leadscout_cron_secret') then
    raise exception 'Store the cron secret in Vault first: select vault.create_secret(''<the CRON_SECRET value>'', ''leadscout_cron_secret'');';
  end if;
end $$;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- One row per tick: where it came from, each batch it ran, why it stopped. Counts of sources, articles and
-- companies only; no page text, no names. Service role only — the RLS sweep judges it by a signed-in user
-- reading none of it (src/lib/rls-sweep.ts).
create table if not exists job_ticks (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  source text not null check (source in ('pg_cron', 'vercel_cron', 'manual')),
  batches jsonb not null default '[]'::jsonb,
  batch_count int not null default 0,
  stopped text,
  error text
);
create index if not exists job_ticks_started_idx on job_ticks (started_at desc);
-- At most one tick running: a second one cannot insert its row and exits. A tick killed with its invocation
-- leaves its row unfinished; the next tick closes any older than 330 s before inserting.
create unique index if not exists job_ticks_one_running on job_ticks ((finished_at is null)) where finished_at is null;

alter table job_ticks enable row level security;
drop policy if exists job_ticks_service_role_only on job_ticks;
create policy job_ticks_service_role_only on job_ticks for all to service_role using (true) with check (true);

-- Re-runnable: drop this migration's schedules before creating them.
select cron.unschedule(jobid) from cron.job where jobname in ('leadscout-tick', 'leadscout-cron-history-prune');

select cron.schedule('leadscout-tick', '*/5 * * * *', $tick$
  select net.http_post(
    url := 'https://leadscout-rfbt.vercel.app/api/jobs/tick',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-tick-source', 'pg_cron',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'leadscout_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
$tick$);

-- pg_cron keeps a row per run forever; 288 a day from the tick alone.
select cron.schedule('leadscout-cron-history-prune', '30 3 * * *', $prune$
  delete from cron.job_run_details where end_time < now() - interval '7 days';
$prune$);
