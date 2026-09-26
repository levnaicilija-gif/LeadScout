-- Item 20 step 3e: the shared tables lose their write GRANTS, so the boundary stops depending on a policy.
--
-- 0053's own comment flagged this as the step still to come: it swapped seven read policies onto the
-- entitlement and left the table grants exactly as they were. That is a real gap rather than tidiness.
-- 0028 is the precedent and states it plainly — role, workspace and onboarding day are the service role's to
-- set, and what ENFORCES that is the REVOKE, not the policy. A policy is a filter over rows a caller is
-- already allowed to touch; a grant is whether they may touch the table at all. While `insert`, `update` and
-- `delete` remain granted to `authenticated`, every one of these tables is one accidentally permissive
-- policy away from being writable, and the shared pool means such a row is visible to every workspace.
--
-- TEN TABLES, NOT TWELVE. `sources` and `radar_runs` were in this bucket when the step was written and left
-- it in 0055 — sources to private, radar_runs to service — so the list here is the registry's current
-- `shared` bucket: leads, companies, articles, lead_articles, lead_people, people, contacts,
-- company_email_patterns, job_posts, radar_verdicts.
--
-- THE WRITE INVENTORY WAS RE-RUN RATHER THAN INHERITED, because the earlier one was taken when the bucket
-- held a different set of tables. Result: ZERO signed-in writes to any of the ten. Every write in src/ is a
-- service-role path — the job routes and the crawl libraries (industry-store, same-contract,
-- company-contact-discovery, find-or-create-company, person-contact, email-pattern), each of which takes its
-- client as a parameter and is called only from `supabaseAdmin`. Two scanning traps were hit and corrected on
-- the way, both already recorded in CLAUDE.md as classes: a same-line grep MISSES a write chained onto the
-- next line, and a three-line context window INVENTS one by catching a later write to a different table
-- (`sb.from('companies').select(...)` followed three lines down by `sb.from('sends').insert(...)`).
--
-- THREE POLICIES ALSO BECOME `for select`. Seven of the ten already are, from 0053. The other three still
-- carry `for all`, and `people` has NO `with check` — the same shape as the `sources` hole 0055 closed, where
-- Postgres reuses the USING expression as the insert check. Their READ scope is deliberately unchanged:
-- each keeps `workspace_id = my_workspace()` exactly as today, because 3c's visibility model is settled and
-- this step is about writes. A policy that still says `for all` while the grants forbid writing is a
-- document that lies about the system, which is the thing this project keeps paying for.

begin;

-- ---------------------------------------------------------------- the three remaining `for all` policies
drop policy if exists ws_people on people;
drop policy if exists read_people on people;
create policy read_people on people for select using (workspace_id = my_workspace());

drop policy if exists company_email_patterns_ws on company_email_patterns;
drop policy if exists read_company_email_patterns on company_email_patterns;
create policy read_company_email_patterns on company_email_patterns for select using (workspace_id = my_workspace());

drop policy if exists radar_verdicts_ws on radar_verdicts;
drop policy if exists read_radar_verdicts on radar_verdicts;
create policy read_radar_verdicts on radar_verdicts for select using (workspace_id = my_workspace());

-- ---------------------------------------------------------------- the grants themselves
revoke insert, update, delete on leads                  from anon, authenticated;
revoke insert, update, delete on companies              from anon, authenticated;
revoke insert, update, delete on articles               from anon, authenticated;
revoke insert, update, delete on lead_articles          from anon, authenticated;
revoke insert, update, delete on lead_people            from anon, authenticated;
revoke insert, update, delete on people                 from anon, authenticated;
revoke insert, update, delete on contacts               from anon, authenticated;
revoke insert, update, delete on company_email_patterns from anon, authenticated;
revoke insert, update, delete on job_posts              from anon, authenticated;
revoke insert, update, delete on radar_verdicts         from anon, authenticated;

-- Reading is what the screens do, and every one of these is read by a signed-in user somewhere.
grant select on leads, companies, articles, lead_articles, lead_people, people, contacts,
                company_email_patterns, job_posts, radar_verdicts to authenticated;

-- The crawl owns every write. Stated rather than assumed: service_role bypasses RLS but still needs the grant.
grant all on leads, companies, articles, lead_articles, lead_people, people, contacts,
              company_email_patterns, job_posts, radar_verdicts to service_role;

-- ---------------------------------------------------------------- proof, both sides of every claim
--
-- pg_policies is unreachable through PostgREST, so this block is the only evidence the step landed. Every
-- assertion is two-sided: the thing that must exist AND the thing that must be gone.
do $$
declare
  t text;
  n int;
  shared text[] := array['leads','companies','articles','lead_articles','lead_people','people','contacts','company_email_patterns','job_posts','radar_verdicts'];
begin
  foreach t in array shared loop
    -- 1. No write grant survives for either signed-in role. This is the boundary; everything else is a filter.
    if has_table_privilege('authenticated', t, 'INSERT') or has_table_privilege('authenticated', t, 'UPDATE')
       or has_table_privilege('authenticated', t, 'DELETE') then
      raise exception '0056: authenticated can still write %', t;
    end if;
    if has_table_privilege('anon', t, 'INSERT') or has_table_privilege('anon', t, 'UPDATE')
       or has_table_privilege('anon', t, 'DELETE') then
      raise exception '0056: anon can still write %', t;
    end if;

    -- 2. And reading still works, or this migration has taken the screens down instead of protecting them.
    if not has_table_privilege('authenticated', t, 'SELECT') then
      raise exception '0056: authenticated cannot read % any more', t;
    end if;
    if not has_table_privilege('service_role', t, 'INSERT') then
      raise exception '0056: service_role cannot write % — the crawl owns every write to these tables', t;
    end if;

    -- 3. No policy on any of the ten permits anything but SELECT. A `for all` policy beside a revoked grant
    --    is a document that lies about the system: the next reader trusts the policy, not the grant.
    select count(*) into n from pg_policies
      where schemaname = 'public' and tablename = t and cmd <> 'SELECT' and 'service_role' <> all(coalesce(roles, array['public']));
    if n <> 0 then raise exception '0056: % still carries % non-SELECT policy(ies) for a signed-in role', t, n; end if;
  end loop;

  -- 4. The three converted policies exist by their new names and are gone by their old ones.
  select count(*) into n from pg_policies where schemaname = 'public'
    and policyname in ('read_people','read_company_email_patterns','read_radar_verdicts');
  if n <> 3 then raise exception '0056: expected 3 new read policies, found %', n; end if;
  select count(*) into n from pg_policies where schemaname = 'public'
    and policyname in ('ws_people','company_email_patterns_ws','radar_verdicts_ws');
  if n <> 0 then raise exception '0056: % old for-all policy(ies) survive', n; end if;

  raise notice '0056 OK: 10 shared tables are read-only to a signed-in user, by GRANT as well as by policy';
end $$;

commit;
