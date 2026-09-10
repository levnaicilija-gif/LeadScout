-- Where an employer type came from.
--
-- The detector reads a name, which says nothing about "Karstensens", so 311 companies with a
-- careers board sat at "unknown" and the agency filter could not protect anyone. Reading each
-- company's own careers page answers it — but the standing rule is that a field like this needs
-- a page behind it, so the evidence and the time are stored with the verdict.

alter table companies add column if not exists employer_type_source text;      -- name | careers_page | seed
alter table companies add column if not exists employer_type_evidence text;    -- what the page said
alter table companies add column if not exists employer_type_checked_at timestamptz;

create index if not exists companies_employer_checked_idx on companies (workspace_id, employer_type_checked_at);
