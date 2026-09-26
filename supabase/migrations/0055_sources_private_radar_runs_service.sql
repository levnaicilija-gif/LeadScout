-- Item 20 step 3d: `sources` becomes PRIVATE and closes a real write hole; `radar_runs` becomes SERVICE.
--
-- THE HOLE IN `sources` IS REAL, UNEXPLOITED, AND HAS BEEN THERE SINCE 0001. Its policy is
--
--   create policy ws_sources on sources for all using (workspace_id = my_workspace() or workspace_id is null);
--
-- with NO `with check`. Postgres reuses the USING expression as the check for INSERT and UPDATE when
-- `with check` is absent, so that one clause does three things at once: it lets a signed-in user READ every
-- null-workspace row, WRITE new rows carrying workspace_id null, and those rows are then visible to EVERY
-- workspace by the same clause. A signed-in recruiter could add a crawl source for everybody. Measured
-- 2026-09-26: 610 rows, 0 of them null-workspace, so nothing has exploited it — which is the reason this can
-- be tightened in one step instead of an expand/contract.
--
-- WHY PRIVATE RATHER THAN SHARED. The sites the crawl reads are this workspace's own strategy, not a
-- discovered fact about the world, and all 610 belong to RFBT. Under the new policy a second workspace reads
-- zero sources, which is EXACTLY what it reads today (610 owned by RFBT, 0 null), so no screen changes. The
-- three signed-in readers keep their SELECT: settings/page.tsx lists them, radar/page.tsx takes the newest
-- last_crawled_at, home/page.tsx counts the enabled priority tier.
--
-- NO WRITE POLICY AT ALL, because there is nothing to support: every write to `sources` in src/ is a
-- service-role job route — classify-sources, repair-sources, radar-batch and job-boards-batch all stamp it
-- with supabaseAdmin. The revoke below is what enforces that, following 0028's lesson that the REVOKE is the
-- boundary and the policy is only the filter.
--
-- `radar_runs` IS THE CRAWL'S OWN CURSOR AND TALLY. No screen reads it, and "shared" cannot mean anything for
-- it: there is no entitlement path to support, and the crawl runs once for everyone. It keeps a MARKER POLICY
-- rather than none, following 0027's `jobs_service_role_only` precedent — service_role bypasses RLS entirely,
-- so the policy exists to satisfy 0026's `rls_tables_without_policy()`, which names a table with RLS on and
-- no policy even when it has no rows and would turn Home's "Data access check" pill red for everyone. That is
-- not hypothetical: 0049's two backup tables did exactly that.
--
-- ONE ROW OF `radar_runs` CARRIES workspace_id null (2026-09-12T04:00:46Z, tier priority, cursor 0, batch 5,
-- tally leads 0). It is left exactly as it is: nothing user-facing reads this table, radar-batch reads its own
-- cursor with the service role which bypasses RLS, and deleting a real telemetry row to tidy a policy change
-- would be destroying evidence for no gain.

begin;

-- ---------------------------------------------------------------- sources: private, read-only to a user
drop policy if exists ws_sources on sources;
drop policy if exists read_sources on sources;
create policy read_sources on sources for select using (workspace_id = my_workspace());

revoke insert, update, delete on sources from anon, authenticated;
grant select on sources to authenticated;
grant all on sources to service_role;

-- ---------------------------------------------------------------- radar_runs: service role only
drop policy if exists radar_runs_ws on radar_runs;
drop policy if exists radar_runs_service_role_only on radar_runs;
create policy radar_runs_service_role_only on radar_runs for all to service_role using (true) with check (true);

revoke all on radar_runs from anon, authenticated;
grant all on radar_runs to service_role;

-- ---------------------------------------------------------------- proof, both sides of every claim
--
-- pg_policies is unreachable through PostgREST (PGRST205), so this block is the ONLY evidence the swap landed.
-- Every assertion is TWO-SIDED: the new thing must exist AND the old thing must be gone, because a migration
-- that only checks for what it added passes just as happily when it added it alongside what it meant to replace.
do $$
declare
  n int;
  def text;
begin
  -- 1. sources: read_sources exists, ws_sources does not.
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'sources' and policyname = 'read_sources';
  if n <> 1 then raise exception '0055: read_sources is not on sources (% found)', n; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'sources' and policyname = 'ws_sources';
  if n <> 0 then raise exception '0055: ws_sources is STILL on sources — the hole is open'; end if;

  -- 2. And it is a SELECT policy keyed on my_workspace() with the null arm GONE. The second half is the
  --    point: keeping `or workspace_id is null` would preserve the writable, everyone-visible hole.
  select cmd || ' ' || coalesce(qual, '') into def from pg_policies where schemaname = 'public' and tablename = 'sources' and policyname = 'read_sources';
  if def not like 'SELECT%' then raise exception '0055: read_sources is not a SELECT-only policy: %', def; end if;
  if def not like '%my_workspace()%' then raise exception '0055: read_sources does not key on my_workspace(): %', def; end if;
  if def like '%IS NULL%' or def like '%is null%' then raise exception '0055: read_sources still admits null-workspace rows: %', def; end if;

  -- 3. sources has NO write policy of any kind for a signed-in caller.
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'sources' and cmd <> 'SELECT';
  if n <> 0 then raise exception '0055: sources still carries % non-SELECT policy(ies)', n; end if;

  -- 4. And the grants agree with the policies. A policy without the revoke is a filter, not a boundary (0028).
  if has_table_privilege('authenticated', 'sources', 'INSERT')
     or has_table_privilege('authenticated', 'sources', 'UPDATE')
     or has_table_privilege('authenticated', 'sources', 'DELETE') then
    raise exception '0055: authenticated can still write sources — the revoke did not take';
  end if;
  if not has_table_privilege('authenticated', 'sources', 'SELECT') then
    raise exception '0055: authenticated cannot read sources — Settings, Radar and Home all read it as the signed-in user';
  end if;

  -- 5. radar_runs: the marker policy exists, the workspace policy does not, and no signed-in grant survives.
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'radar_runs' and policyname = 'radar_runs_service_role_only';
  if n <> 1 then raise exception '0055: radar_runs_service_role_only is not on radar_runs (% found)', n; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'radar_runs' and policyname = 'radar_runs_ws';
  if n <> 0 then raise exception '0055: radar_runs_ws is STILL on radar_runs'; end if;
  if has_table_privilege('authenticated', 'radar_runs', 'SELECT') then
    raise exception '0055: authenticated can still read radar_runs — it is the crawl cursor, not a screen';
  end if;

  -- 6. Nothing was hidden that a screen needs: the row count is untouched and still holds no null-workspace row.
  select count(*) into n from sources;
  if n < 600 then raise exception '0055: sources holds only % rows — this migration must not delete any', n; end if;
  select count(*) into n from sources where workspace_id is null;
  if n <> 0 then raise exception '0055: % null-workspace source row(s) exist, and the new policy makes them unreadable — scope them before applying', n; end if;

  raise notice '0055 OK: sources is private and read-only to a signed-in user (% rows, 0 null-workspace), radar_runs is service-role only', (select count(*) from sources);
end $$;

commit;
