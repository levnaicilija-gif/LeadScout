-- 0053 — discovery becomes shared: seven read policies stop asking who OWNS a row and start asking
-- whether the caller is ENTITLED to it. Item 20 step 3c, and the first step in this project that
-- changes what a signed-in user can see.
--
-- ============================================================================================
-- WHY SEVEN AND NOT TWO
-- ============================================================================================
-- The obvious 3c is `leads` and `companies` alone. That would be a step whose success CANNOT BE
-- DEMONSTRATED, which is the one standard every step of this project has held to.
--
-- Five more tables scope through the OWNERSHIP of a lead or a company, and their policies contain a
-- literal `workspace_id = my_workspace()` rather than a subquery that follows whatever leads' policy
-- becomes: job_posts (0016), contacts (0022), lead_articles, articles and lead_people (0025). Swapping
-- only the first two would show a second workspace every lead and company in the pool STRIPPED of
-- everything hanging off them — no contacts, no postings, no articles, and therefore no lead age at
-- all, since age is computed from the article's published_at. An empty Hiring now. Nothing dangerous;
-- simply a shared pool nobody could verify was working, until two further steps landed.
-- Owner's decision 2026-09-25: take all seven together.
--
-- THE CONSTRUCTION IS THE SAME EVERYWHERE, and it is 3a's: a child asks whether its PARENT is visible,
-- `exists (select 1 from leads l where l.id = …)`, because a subquery inside a policy is itself subject
-- to the referenced table's RLS. Nothing below repeats the entitlement rule. leads and companies ask
-- can_see_industries() once each; every other table inherits it by asking about its parent, and keeps
-- inheriting it if the entitlement ever changes again.
--
-- job_posts ASKS ABOUT THE COMPANY FIRST, AND THAT ORDER IS A FINDING RATHER THAN A STYLE. Measured
-- 2026-09-25: 31 of 105 job_posts carry a null workspace_id, ALL 31 have a company, and NOT ONE has a
-- lead. A lead-only rule would drop every one of them for every account, whatever the entitlement said
-- — a third of the Hiring now board gone, with nothing raised anywhere.
--
-- ============================================================================================
-- FOR SELECT, NOT FOR ALL — THE HOLE THIS STEP WOULD OTHERWISE OPEN
-- ============================================================================================
-- leads, companies, contacts and job_posts carry `for all` policies with no WITH CHECK, so the USING
-- clause governs WRITES as well as reads. Widening USING to an entitlement would therefore hand every
-- entitled workspace the right to UPDATE and DELETE every lead and company in the pool — the exact
-- opposite of the boundary this item exists to build, introduced by the step meant to build it.
--
-- So each becomes `for select`, and no write policy replaces it. With RLS enabled and no write policy,
-- a signed-in write is refused; the service role bypasses RLS and is unaffected, which is what the
-- crawl uses for all 28 of its writes. Verified 2026-09-25 by inventory: there is NOT ONE signed-in
-- write to any of these seven tables anywhere in src/ — every write resolves to api/jobs/*, lib/jobs/*
-- or lib/tender/ingest.ts, all service role. So this removes a capability nothing uses, and it is the
-- 0028 lesson arriving one table at a time: the lock is taking the grant away, not writing a cleverer
-- policy. 3e still follows, to revoke the table grants themselves.
--
-- NO LEAK IS POSSIBLE THROUGH AN EMBED, checked rather than assumed: no private table is embedded off
-- leads or companies anywhere in the codebase. The only cross-table direction in use is outreach →
-- leads, which reads FROM the private side (still scoped by its own 0046 policy) and embeds shared
-- facts onto it.
--
-- WHAT A SECOND WORKSPACE STILL CANNOT DO, so the gap is written down rather than discovered: two
-- routes authorise on ownership and will answer 404 on a shared row — api/leads/send-pack compares
-- lead.workspace_id to the caller's, and api/company/employer-type filters companies by it. Both fail
-- CLOSED, both are step 3f, and neither is reachable today: the only other workspace's user has never
-- signed in (last_seen_at null, created 2026-09-14). 3f must land before a second workspace is used.

-- ---- the two that carry the entitlement -----------------------------------------------------------
drop policy if exists ws_leads on leads;
drop policy if exists read_leads on leads;
create policy read_leads on leads for select using (public.can_see_industries(industries));

drop policy if exists ws_companies on companies;
drop policy if exists read_companies on companies;
create policy read_companies on companies for select using (public.can_see_industries(industries));

-- ---- and the five that inherit it from their parent ----------------------------------------------
-- The company arm is first on purpose: see the 31 rows above.
drop policy if exists ws_job_posts on job_posts;
drop policy if exists read_job_posts on job_posts;
create policy read_job_posts on job_posts for select using (
  (company_id is not null and exists (select 1 from companies c where c.id = job_posts.company_id))
  or (lead_id is not null and exists (select 1 from leads l where l.id = job_posts.lead_id))
);

drop policy if exists ws_contacts on contacts;
drop policy if exists read_contacts on contacts;
create policy read_contacts on contacts for select using (
  (lead_id is not null and exists (select 1 from leads l where l.id = contacts.lead_id))
  or (company_id is not null and exists (select 1 from companies c where c.id = contacts.company_id))
);

drop policy if exists ws_lead_articles on lead_articles;
drop policy if exists read_lead_articles on lead_articles;
create policy read_lead_articles on lead_articles for select using (
  exists (select 1 from leads l where l.id = lead_articles.lead_id)
);

-- articles reaches its lead through lead_articles, whose policy is itself now entitlement-following.
-- The 471 of 1,558 articles that back no lead therefore stay service-only, exactly as under 0025.
drop policy if exists ws_articles on articles;
drop policy if exists read_articles on articles;
create policy read_articles on articles for select using (
  exists (select 1 from lead_articles la where la.article_id = articles.id)
);

drop policy if exists ws_lead_people on lead_people;
drop policy if exists read_lead_people on lead_people;
create policy read_lead_people on lead_people for select using (
  exists (select 1 from leads l where l.id = lead_people.lead_id)
);

-- ============================================================================================
-- VERIFIED HERE, TWO-SIDED, BECAUSE A PROBE CANNOT READ A POLICY
-- ============================================================================================
-- pg_policies is unreachable through PostgREST (PGRST205), so this block is the only thing that can
-- confirm the swap landed. 0051 taught the shape: its first version asserted a pattern the OLD policy
-- also matched, and would have passed while changing nothing. So every table below is checked from both
-- ends — the new rule is present AND the ownership rule is gone AND no write policy survives.
do $$
declare
  t text; expect text; n integer; q text;
  spec text[][] := array[
    ['leads',         'can_see_industries'],
    ['companies',     'can_see_industries'],
    ['job_posts',     'FROM companies'],
    ['contacts',      'FROM leads'],
    ['lead_articles', 'FROM leads'],
    ['articles',      'FROM lead_articles'],
    ['lead_people',   'FROM leads']
  ];
begin
  -- 0052 must be in, or every policy above raises at query time and the whole app goes dark.
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and p.proname = 'can_see_industries') then
    raise exception '0053: can_see_industries() does not exist — apply 0052 first, or every read policy here fails at query time';
  end if;

  for i in 1 .. array_length(spec, 1) loop
    t := spec[i][1];
    expect := spec[i][2];

    -- RLS must still be ON. A policy on a table with RLS off protects nothing.
    if not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                    where ns.nspname = 'public' and c.relname = t and c.relrowsecurity) then
      raise exception '0053: RLS is not enabled on % — its policy would protect nothing', t;
    end if;

    -- 1. The new read policy exists, and is SELECT-only.
    select count(*) into n from pg_policies
     where schemaname = 'public' and tablename = t and policyname = 'read_' || t and cmd = 'SELECT';
    if n <> 1 then raise exception '0053: % has no SELECT policy called read_% — reads would be refused outright', t, t; end if;

    -- 2. It carries the expected rule.
    select qual into q from pg_policies where schemaname = 'public' and tablename = t and policyname = 'read_' || t;
    if q is null or position(expect in q) = 0 then
      raise exception '0053: read_%''s USING clause does not mention % — it is: %', t, expect, q;
    end if;

    -- 3. THE OTHER SIDE: the ownership rule is gone. Without this the whole migration could pass while
    --    changing nothing, which is precisely how 0051''s first verification was wrong.
    if position('my_workspace' in q) > 0 then
      raise exception '0053: read_% still keys on my_workspace() — this is the OLD ownership rule and no second workspace would see anything: %', t, q;
    end if;

    -- 4. NO WRITE POLICY SURVIVES. leads, companies, contacts and job_posts were `for all` with no WITH
    --    CHECK, so leaving one would hand every entitled workspace UPDATE and DELETE on the whole pool.
    select count(*) into n from pg_policies
     where schemaname = 'public' and tablename = t and cmd <> 'SELECT';
    if n <> 0 then
      raise exception '0053: % still has % non-SELECT policy/policies — an entitled workspace could write the whole pool', t, n;
    end if;
  end loop;

  -- 5. And nothing moved. This migration rewrites policies; a changed row means it did something else.
  if (select count(*) from workspace_lead_state) <> (select count(*) from leads where workspace_id is not null) then
    raise exception '0053: lead state stopped being total — no row should have been touched';
  end if;

  raise notice '0053: seven read policies now follow entitlement, none keys on ownership, none permits a signed-in write';
end $$;
