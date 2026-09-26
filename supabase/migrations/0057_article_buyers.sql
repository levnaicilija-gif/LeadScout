-- Item 29: the contracting authority becomes a readable FACT on the article, backfilled for free.
--
-- WHY A COLUMN AT ALL, WHEN THE BUYER IS ALREADY IN THE TEXT. It is, and `buyersFromAwardText()` reads it —
-- but only from text the caller already holds, and the Leads list deliberately does NOT load article text.
-- Measured 2026-09-27: a TED notice is a median 5,051 characters, so fetching text for 50 award leads costs
-- about 301 KB per render to read roughly 60 characters, because "Contracting authority:" sits at character 84.
-- Paying that on every page load to answer one question is the wrong trade.
--
-- STORE THE FACT, COMPUTE THE JUDGEMENT — the split this codebase has already proved three times. Lead age,
-- compound signals and certificate-only are all computed ON READ from stored facts, precisely because a stored
-- VERDICT goes stale and nobody clears it (a flag saying "certificate-only" survives the CV that disproves it).
-- So this migration stores only what the notice SAYS — the buyer names, copied verbatim — and the municipal
-- judgement stays in TypeScript, computed on read. Change the rule and every lead is re-judged instantly with
-- no backfill, which is the property that actually mattered.
--
-- `buyers` IS AN ARRAY, NOT A NAME. award.ts writes one "Contracting authority:" line per buyer (:152), and a
-- joint procurement genuinely has several. Keeping the first would silently decide that a town council sharing
-- a contract with a grid operator is only a town council, and the whole point of item 29 is that the buyer
-- separates work worth doing from work that is not.
--
-- NULLABLE AND NOT UNIVERSAL, and the threshold is measured rather than assumed. 181 TED articles: the 153
-- that back a lead ALL carry the line, but of the 28 with no lead only 20 do — 8 carry no such line at all,
-- predating the awardText format. So the assertion below is "every article that CARRIES the line is
-- backfilled", NOT "every TED article has a buyer". Asserting the stronger claim would have failed on 8 rows
-- that are not wrong, merely older, and that is how a migration ends up refusing correct data.
--
-- NO MODEL CALL, matching item 12's EUR 0 design: this is a regex over text already in the table.

begin;

alter table articles add column if not exists buyers text[];

comment on column articles.buyers is
  'Contracting authorities copied verbatim from the award notice (item 29). A FACT, never a judgement: whether a buyer is municipal is computed on read in src/lib/tender/municipal-buyer.ts so the rule can change without a backfill.';

-- The backfill. One row per "Contracting authority:" line, in the order the notice states them, with the
-- sentinel award.ts writes when a notice names nobody ('not stated in the notice') excluded — storing that
-- string as if it were a buyer is exactly the kind of value that later reads as real.
update articles
   set buyers = (
     select array_agg(m[1] order by ord)
       from regexp_matches(articles.text, 'Contracting authority: ([^\n]+)', 'g') with ordinality as t(m, ord)
      where m[1] <> 'not stated in the notice'
   )
 where text is not null
   and url like '%ted.europa.eu%'
   and buyers is null;

-- An index only if reads want one. They do not yet: the Leads list reads `buyers` through lead_articles by
-- primary key, so there is nothing to scan. Deliberately not added rather than added "just in case" — an
-- unused index is write cost on every crawl for no read benefit.

do $$
declare
  with_line int;
  filled int;
  no_line int;
  sample text;
begin
  -- 1. The column exists and is the right shape. `text[]`, not text: a joint procurement has several buyers.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'articles' and column_name = 'buyers' and data_type = 'ARRAY'
  ) then
    raise exception '0057: articles.buyers is missing or is not an array';
  end if;

  -- 2. EVERY TED article that carries the line has been backfilled. This is the real assertion: the migration
  --    must make the data satisfy the claim rather than merely adding a column (the 0014 lesson).
  select count(*) into with_line from articles
   where url like '%ted.europa.eu%' and text ~ 'Contracting authority: [^\n]+';
  select count(*) into filled from articles
   where url like '%ted.europa.eu%' and text ~ 'Contracting authority: [^\n]+'
     and buyers is not null and cardinality(buyers) > 0;
  if filled <> with_line then
    raise exception '0057: % TED article(s) carry a Contracting authority line but only % were backfilled', with_line, filled;
  end if;

  -- 3. And the other side: articles WITHOUT the line are left null rather than given an empty array, because
  --    "the notice does not say" and "the notice says nobody" are different facts and null is the honest one.
  select count(*) into no_line from articles
   where url like '%ted.europa.eu%' and (text is null or text !~ 'Contracting authority: [^\n]+');
  if exists (
    select 1 from articles
     where url like '%ted.europa.eu%' and (text is null or text !~ 'Contracting authority: [^\n]+') and buyers is not null
  ) then
    raise exception '0057: an article with no Contracting authority line was given a buyers value';
  end if;

  -- 4. The sentinel never made it in. If it had, every notice naming nobody would read as a buyer called
  --    "not stated in the notice", and the municipal rule would be judging a sentence.
  if exists (select 1 from articles where 'not stated in the notice' = any(buyers)) then
    raise exception '0057: the not-stated sentinel was stored as a buyer';
  end if;

  select buyers[1] into sample from articles
   where buyers is not null and cardinality(buyers) > 0 order by id limit 1;
  raise notice '0057 OK: % TED article(s) carry a buyer line and all are backfilled; % carry none and stay null. First buyer: %',
    with_line, no_line, coalesce(sample, '(none)');
end $$;

commit;
