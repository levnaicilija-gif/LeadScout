-- Right to work, which is a gate before it is a preference.
--
-- A welder without an EU passport cannot start on a Danish site, however good the CV, and an EU
-- passport alone is not enough for a UK one. Getting this wrong wastes a client's time and the
-- candidate's, so it is a blocker in scoring rather than a note on the card.
--
-- Every field records where the answer came from. "EU passport: yes" with nothing behind it is
-- the kind of claim this system exists to avoid.

alter table candidates add column if not exists nationality text;                 -- ISO-3166 alpha-2
alter table candidates add column if not exists eu_passport boolean;              -- null = not yet known
alter table candidates add column if not exists eu_passport_source text;          -- 'passport' | 'cv' | 'recruiter'
alter table candidates add column if not exists eu_passport_document_id uuid references documents(id);
alter table candidates add column if not exists uk_right_to_work boolean;         -- null = not yet known
alter table candidates add column if not exists uk_right_to_work_basis text;      -- settled | pre_settled | work_visa | citizen | none
alter table candidates add column if not exists uk_right_to_work_source text;
alter table candidates add column if not exists uk_right_to_work_document_id uuid references documents(id);
alter table candidates add column if not exists right_to_work_checked_at timestamptz;

create index if not exists candidates_rtw_idx on candidates (workspace_id, eu_passport, uk_right_to_work);

-- Where this workspace's candidates come from. A list, so a recruiter can change it without a
-- deploy, and so the LinkedIn search stops defaulting to Serbia for an EU job.
alter table workspaces add column if not exists candidate_countries text[]
  default array['RO','PL','HR','BG','PT','LT','SK','HU','GR','ES','IT'];
