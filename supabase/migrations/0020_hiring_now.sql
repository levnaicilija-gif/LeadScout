-- 0020 — Hiring now: contacts on a company, outreach without a lead, row state, test marking.
--
-- Hiring now rows are companies, not leads. A lead is something a recruiter decides to create;
-- a posting is a fact about a company that was read this morning. Everything below exists so a
-- recruiter can act on a posting without a lead having to be invented first.

-- ------------------------------------------------------- contact on a posting
-- The contact printed on the advert itself. The posting's own source_url is the evidence, so
-- there is no second source column: if it is on this row, it was read from that page.
alter table job_posts add column if not exists contact_name text;
alter table job_posts add column if not exists contact_title text;
alter table job_posts add column if not exists contact_email text;
alter table job_posts add column if not exists contact_phone text;

-- --------------------------------------------------- contact page on a company
-- companies already carries switchboard, general_email, email_pattern and careers_url with
-- their source URLs. What was missing is where the contact details were read from, and when we
-- last looked — without that the discovery job re-crawls the same page every morning.
alter table companies add column if not exists contact_page_url text;
alter table companies add column if not exists contacts_checked_at timestamptz;

-- ------------------------------------------------------------- row state
-- What a recruiter has decided about a hiring-now company. Deliberately separate from
-- leads.status: this is a decision about a company's hiring, not about a lead.
--   pursued    -> appears in Today
--   not_for_us -> hidden from the table
alter table companies add column if not exists hiring_status text
  check (hiring_status in ('new','pursued','not_for_us'));
alter table companies add column if not exists hiring_status_at timestamptz;
alter table companies add column if not exists hiring_status_by uuid references users(id);
-- "I checked the board myself" — the same claim Confirm makes on a lead.
alter table companies add column if not exists hiring_confirmed_at timestamptz;
alter table companies add column if not exists hiring_confirmed_by uuid references users(id);

-- --------------------------------------------------------- outreach to a company
-- outreach keys on lead_id. A hiring-now approach has no lead behind it, so it keys on the
-- company and records which postings it was written from — the draft cites them, and six months
-- later the question is which adverts it was answering.
alter table outreach add column if not exists company_id uuid references companies(id);
alter table outreach add column if not exists job_post_ids uuid[] default '{}';
alter table outreach alter column lead_id drop not null;

create index if not exists outreach_company_idx on outreach (company_id) where company_id is not null;
create index if not exists job_posts_company_open_idx on job_posts (company_id) where status = 'open';

-- ------------------------------------------------------------- test marking
-- Probe and smoke runs create real rows in a real database. They already clean up after
-- themselves, but a cleanup that matches on anything other than "this row is test data" can
-- delete a real record — so the flag is explicit, defaults to false, and cleanup filters on it.
-- A row without the flag is real, always.
alter table workspaces  add column if not exists is_test boolean not null default false;
alter table companies   add column if not exists is_test boolean not null default false;
alter table leads       add column if not exists is_test boolean not null default false;
alter table candidates  add column if not exists is_test boolean not null default false;
alter table job_posts   add column if not exists is_test boolean not null default false;
alter table documents   add column if not exists is_test boolean not null default false;
alter table contacts    add column if not exists is_test boolean not null default false;
alter table outreach    add column if not exists is_test boolean not null default false;

create index if not exists workspaces_test_idx on workspaces (is_test) where is_test;
