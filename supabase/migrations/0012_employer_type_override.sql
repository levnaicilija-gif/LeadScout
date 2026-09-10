-- A recruiter's decision about what a company is beats any keyword.
--
-- Worley, Wood, Saipem, Fluor, DEME, KAEFER, SPIE and Altrad were all filed as staffing
-- agencies. They came from seeds/agencies.csv, which is a list of competitors AND peers — its
-- own "focus" column calls Worley "Energy EPC & services" — and once one row carried the label
-- the detector's substring matching spread it to every company whose name contained theirs.
--
-- The override is separate from the detected value on purpose: re-classification must never
-- overwrite a person's judgement, and the reason has to survive so the decision can be argued
-- with later.

alter table companies add column if not exists employer_type_override employer_type;
alter table companies add column if not exists employer_type_set_by uuid references users(id);
alter table companies add column if not exists employer_type_set_at timestamptz;
alter table companies add column if not exists employer_type_reason text;

-- What the rest of the system should read: the override where one exists, else the detector.
create or replace function effective_employer_type(detected employer_type, override employer_type)
returns employer_type language sql immutable as $$
  select coalesce(override, detected, 'unknown'::employer_type)
$$;

create index if not exists companies_employer_type_idx on companies (workspace_id, employer_type_override, employer_type);
