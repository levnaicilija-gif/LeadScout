-- Employment contracts set availability and tell us where someone currently is.
--
-- Deliberately absent: rate, allowances, pension, bonus and date of birth. Those stay in the
-- uploaded file and never reach a profile, a bullet or any PDF — the extraction prompt is told
-- not to return them, and there is nowhere here to put them if it did.
alter table candidates add column if not exists current_employer text;   -- internal only
alter table candidates add column if not exists current_site text;       -- internal only
alter table candidates add column if not exists contract_end date;

comment on column candidates.current_employer is 'Internal only — never rendered on a client PDF or in client bullets.';
comment on column candidates.current_site is 'Internal only — never rendered on a client PDF or in client bullets.';
