-- 0024 — the date an award was decided, as a column (queue item 17).
--
-- A tender-award lead is aged from its award decision date, else the contract's conclusion date,
-- else the notice's publication date. TED states the first two (winner-decision-date,
-- contract-conclusion-date), but they were written only into the notice's stored text as
-- "Award date: 2026-01-05 (award decision)" — and the Leads screen does not load that text, which
-- also carries the whole API record. On 2026-09-13: 46 of 110 notices state an award decision,
-- 63 a contract conclusion, 1 neither.
--
-- This stores a fact the notice states. It is not a status and sets none: a lead's age is
-- computed when it is read (src/lib/lead-age.ts).

alter table articles add column if not exists award_date date;
alter table articles add column if not exists award_date_basis text;

do $$ begin
  alter table articles add constraint articles_award_date_basis_check
    check (award_date_basis is null or award_date_basis in ('award decision', 'contract concluded'));
exception when duplicate_object then null; end $$;

-- Filled from the line awardText wrote, only where it states a date. "not stated in the notice"
-- matches nothing and stays null. Safe to run twice.
update articles a
   set award_date = (m.hit)[1]::date,
       award_date_basis = (m.hit)[2]
  from (
    select id, regexp_match(text, 'Award date: (\d{4}-\d{2}-\d{2}) \((award decision|contract concluded)\)') as hit
      from articles
     where url like 'https://ted.europa.eu/%' and award_date is null
  ) m
 where a.id = m.id and m.hit is not null;
