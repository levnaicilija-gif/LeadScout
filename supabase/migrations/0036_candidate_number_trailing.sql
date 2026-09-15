-- Item 24 (2026-09-15): candidate_number is the reference code's trailing number, not every digit in it.
--
-- Found by scripts/candidate-pool-scale.ts the day 0035 was applied: 0035 computed the number from all the digits in the
-- code (regexp_replace '\D'), so a code with digits before its number — "SCALE419156-X-00000" — became 41915600000 and
-- the insert failed as out of range for integer, and "PROBE12345-X-9000" would have read as 123459000. Real codes
-- (RFBT-<letter>-<number>) came out right either way, and the screens read the number with src/lib/candidate-number.ts,
-- which already takes the trailing digits. This makes the stored column agree with the screens, and a trailing number too
-- long for an integer is null rather than an insert that fails. No data changes: the column is computed.

alter table candidates drop column if exists candidate_number;
alter table candidates add column candidate_number int
  generated always as (
    case when length(substring(coalesce(reference_code, '') from '(\d+)\s*$')) between 1 and 9
      then substring(reference_code from '(\d+)\s*$')::int
    end
  ) stored;
create index if not exists candidates_number_idx on candidates (workspace_id, candidate_number);
