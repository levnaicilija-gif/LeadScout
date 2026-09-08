-- LeadScout schema. Rule: nothing "verified" without a fetched source. No invented contacts.
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create type employer_type as enum ('end_client','staffing_agency','epc_contractor','unknown');
create type lead_status as enum ('new','pursue','contacted','replied','call','trial','framework','not_for_us','stale');
create type email_status as enum ('found','pattern','unknown');
create type doc_type as enum ('passport','cv','certificate','medical','a1','test_report','other');
create type verify_method as enum ('browser_lookup','issuer_email','test_report','manual');
create type verify_result as enum ('valid','invalid','not_found','pending','not_supported','consistent_with_test_report');
create type src_type as enum ('news','tender','job_board','company_press');
create type fetch_status as enum ('live','stale','not_found');

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null, slug text unique not null,
  trades text[] default '{}', supply_countries text[] default '{}', source_countries text[] default '{}',
  created_at timestamptz default now()
);
create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete cascade,
  name text, role text check (role in ('senior','recruiter')) default 'recruiter',
  onboarding_day int default 1, created_at timestamptz default now()
);

create table sources (
  id uuid primary key default gen_random_uuid(), workspace_id uuid references workspaces(id),
  name text, url text not null, type src_type not null, region text, paywalled boolean default false,
  enabled boolean default true, last_crawled_at timestamptz, crawl_prompt text,
  unique (workspace_id, url)
);
create table articles (
  id uuid primary key default gen_random_uuid(), source_id uuid references sources(id),
  url text unique not null, title text, published_at date, fetched_at timestamptz default now(),
  text text, screenshot_path text, last_fetch_status fetch_status default 'live', last_fetch_at timestamptz
);
create table companies (
  id uuid primary key default gen_random_uuid(), workspace_id uuid references workspaces(id),
  name text not null, domain text, employer_type employer_type default 'unknown', size_band text,
  size_source_url text, switchboard text, switchboard_source_url text, general_email text,
  general_email_source_url text, email_pattern text, pattern_source_url text, careers_url text,
  rfbt_history text, unique (workspace_id, name)
);
create table leads (
  id uuid primary key default gen_random_uuid(), workspace_id uuid references workspaces(id),
  company_id uuid references companies(id), kind text check (kind in ('won_work','job_post')) not null,
  project_name text, project_location text, project_value text, phase text, phase_start date, phase_end date,
  trades_inferred text[] default '{}', fit_score int default 0, status lead_status default 'new',
  job_description text, jd_version int default 0,
  source_url text, source_fetch_status fetch_status default 'live', source_fetched_at timestamptz,
  confirmed_by uuid references users(id), confirmed_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table lead_articles (lead_id uuid references leads(id) on delete cascade, article_id uuid references articles(id), primary key (lead_id, article_id));
create table job_posts (
  id uuid primary key default gen_random_uuid(), lead_id uuid references leads(id) on delete cascade,
  role text, trades text[] default '{}', location text, country text, posted_at date, closes_at date,
  certs_required text[] default '{}', rotation text, contract_type text, headcount int,
  source_url text not null, screenshot_path text, poster_type employer_type default 'unknown',
  hiring_pressure text check (hiring_pressure in ('low','medium','high')) default 'low',
  unique (lead_id, source_url)
);
-- A contact MUST come from a page we fetched. quote_article_id or source_url required.
create table contacts (
  id uuid primary key default gen_random_uuid(), lead_id uuid references leads(id) on delete cascade,
  company_id uuid references companies(id), name text not null, title text not null, quote text,
  quote_article_id uuid references articles(id), source_url text,
  email text, email_status email_status default 'unknown', email_source_url text,
  phone text, phone_source_url text, linkedin_search_url text, google_search_url text,
  found_at timestamptz default now(),
  check (quote_article_id is not null or source_url is not null)
);
create table people ( -- seed lists (e.g. WindEurope). Never email/phone here.
  id uuid primary key default gen_random_uuid(), workspace_id uuid references workspaces(id),
  company_name text not null, name text not null, title text, country text, source text not null, ops_relevant boolean default false
);
create table lead_people (lead_id uuid references leads(id) on delete cascade, person_id uuid references people(id), primary key (lead_id, person_id));

create table candidates (
  id uuid primary key default gen_random_uuid(), workspace_id uuid references workspaces(id),
  reference_code text unique, trade_code char(1) default 'O', full_name text, phone text, email text,
  trade text, languages text[] default '{}', availability_from date, rotation_prefs text[] default '{}',
  eu_passport boolean, rate_all_in numeric, rate_margin numeric, profile jsonb default '{}',
  internal_notes text, created_via text check (created_via in ('verify','manual','import')) default 'manual',
  created_by uuid references users(id), created_at timestamptz default now()
);
create sequence candidate_ref_seq start 1;
create or replace function next_reference_code(tc char) returns text language sql as
  $$ select 'RFBT-' || upper(tc) || '-' || lpad(nextval('candidate_ref_seq')::text, 4, '0') $$;

create table documents (
  id uuid primary key default gen_random_uuid(), candidate_id uuid references candidates(id) on delete cascade,
  type doc_type not null, cert_body text, storage_path text not null, extracted jsonb default '{}',
  uploaded_by uuid references users(id), uploaded_at timestamptz default now(),
  status text check (status in ('received','needs_retake','expired','verified','rejected')) default 'received'
);
create table verifications (
  id uuid primary key default gen_random_uuid(), document_id uuid references documents(id) on delete cascade,
  method verify_method not null, checked_where text, checked_at timestamptz, result verify_result not null,
  valid_until date, holder_on_source text, screenshot_path text, notes text,
  issuer_email_sent_at timestamptz, issuer_reply_path text
);
create table anonymized_cvs (
  id uuid primary key default gen_random_uuid(), candidate_id uuid references candidates(id) on delete cascade,
  version int default 1, storage_path text, public_slug text unique, generated_at timestamptz default now(),
  bullets text[] default '{}', certs_cross_check jsonb default '{}', pii_check_passed boolean default false
);
create table campaigns (
  id uuid primary key default gen_random_uuid(), workspace_id uuid references workspaces(id),
  name text not null, company_id uuid references companies(id), starts_on date, ends_on date,
  required_docs doc_type[] default '{passport,medical,certificate,a1}', status text default 'active'
);
create table campaign_candidates (
  campaign_id uuid references campaigns(id) on delete cascade, candidate_id uuid references candidates(id) on delete cascade,
  group_no int, status text default 'shortlisted', primary key (campaign_id, candidate_id)
);
create table scores (
  id uuid primary key default gen_random_uuid(), candidate_id uuid references candidates(id), lead_id uuid references leads(id),
  jd_version int, score int, fits text[] default '{}', missing text[] default '{}', blockers text[] default '{}', scored_at timestamptz default now()
);
create table outreach (
  id uuid primary key default gen_random_uuid(), lead_id uuid references leads(id), contact_id uuid references contacts(id),
  channel text check (channel in ('email','linkedin_copy')), subject text, body text, reasoning text,
  attachments uuid[] default '{}', sent_by uuid references users(id), sent_at timestamptz, reply_at timestamptz,
  status text default 'draft'
);
create table sends (
  id uuid primary key default gen_random_uuid(), candidate_id uuid references candidates(id), company_id uuid references companies(id),
  anonymized_cv_id uuid references anonymized_cvs(id), score_id uuid references scores(id), sent_by uuid references users(id),
  sent_at timestamptz default now(), revealed_at timestamptz, revealed_by uuid references users(id)
);
create table jobs ( -- worker queue
  id uuid primary key default gen_random_uuid(), kind text not null, payload jsonb not null,
  status text default 'queued', attempts int default 0, created_at timestamptz default now(), finished_at timestamptz, error text
);

create index on leads (workspace_id, status, fit_score desc);
create index on companies using gin (name gin_trgm_ops);
create index on people using gin (company_name gin_trgm_ops);
create index on verifications (result, valid_until);

-- RLS: everything scoped to workspace
alter table workspaces enable row level security; alter table users enable row level security;
alter table leads enable row level security; alter table candidates enable row level security;
alter table companies enable row level security; alter table contacts enable row level security;
alter table documents enable row level security; alter table verifications enable row level security;
alter table anonymized_cvs enable row level security; alter table outreach enable row level security;
alter table sends enable row level security; alter table campaigns enable row level security;
alter table campaign_candidates enable row level security; alter table scores enable row level security;
alter table job_posts enable row level security; alter table people enable row level security; alter table sources enable row level security;

create or replace function my_workspace() returns uuid language sql stable as
  $$ select workspace_id from users where id = auth.uid() $$;

create policy ws_users on users for all using (id = auth.uid() or workspace_id = my_workspace());
create policy ws_workspaces on workspaces for select using (id = my_workspace());
create policy ws_leads on leads for all using (workspace_id = my_workspace());
create policy ws_candidates on candidates for all using (workspace_id = my_workspace());
create policy ws_companies on companies for all using (workspace_id = my_workspace());
create policy ws_people on people for all using (workspace_id = my_workspace());
create policy ws_sources on sources for all using (workspace_id = my_workspace() or workspace_id is null);
create policy ws_campaigns on campaigns for all using (workspace_id = my_workspace());
create policy ws_contacts on contacts for all using (lead_id in (select id from leads where workspace_id = my_workspace()));
create policy ws_job_posts on job_posts for all using (lead_id in (select id from leads where workspace_id = my_workspace()));
create policy ws_documents on documents for all using (candidate_id in (select id from candidates where workspace_id = my_workspace()));
create policy ws_verifications on verifications for all using (document_id in (select d.id from documents d join candidates c on c.id=d.candidate_id where c.workspace_id = my_workspace()));
create policy ws_anon on anonymized_cvs for all using (candidate_id in (select id from candidates where workspace_id = my_workspace()));
create policy ws_scores on scores for all using (candidate_id in (select id from candidates where workspace_id = my_workspace()));
create policy ws_outreach on outreach for all using (lead_id in (select id from leads where workspace_id = my_workspace()));
create policy ws_sends on sends for all using (candidate_id in (select id from candidates where workspace_id = my_workspace()));
create policy ws_cc on campaign_candidates for all using (campaign_id in (select id from campaigns where workspace_id = my_workspace()));

-- Public verification summary: cert statuses only, no PII. Served via service role in /v/[slug].
insert into storage.buckets (id, name, public) values ('documents','documents',false), ('screenshots','screenshots',false), ('pdfs','pdfs',false) on conflict do nothing;

-- On sign-up: create a workspace from user metadata and the users row (first user = senior).
create or replace function handle_new_user() returns trigger language plpgsql security definer as $$
declare ws uuid;
begin
  insert into workspaces (name, slug) values (coalesce(new.raw_user_meta_data->>'agency','My agency'), lower(regexp_replace(coalesce(new.raw_user_meta_data->>'agency','ws') || '-' || left(new.id::text,6), '[^a-z0-9]+', '-', 'g'))) returning id into ws;
  insert into users (id, workspace_id, name, role) values (new.id, ws, new.raw_user_meta_data->>'name', 'senior');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();
