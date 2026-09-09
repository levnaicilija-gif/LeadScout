-- Hiring now: a company universe with a geography gate, careers-page discovery and the
-- bookkeeping that keeps a daily crawl cheap.

-- ---------------------------------------------------------------- companies
alter table companies add column if not exists sector text;              -- offshore_wind | shipyard | oil_gas | epc | industrial | other
alter table companies add column if not exists country text;             -- ISO-3166 alpha-2, upper case
alter table companies add column if not exists region text;              -- europe | non_europe | unknown  (derived, see is_european)
alter table companies add column if not exists tier text;                -- priority | europe | outside  (crawl cadence)
alter table companies add column if not exists source text;              -- where this company came from
alter table companies add column if not exists source_url text;
alter table companies add column if not exists employees int;
alter table companies add column if not exists revenue text;
alter table companies add column if not exists registry text;            -- companies_house | cvr | brreg | kvk | bolagsverket | handelsregister
alter table companies add column if not exists registry_id text;         -- company number in that registry
alter table companies add column if not exists registry_checked_at timestamptz;

-- Careers-page discovery. ats_type non-null means we can read JSON instead of crawling HTML.
alter table companies add column if not exists ats_type text;
alter table companies add column if not exists ats_slug text;            -- the board id inside that ATS
alter table companies add column if not exists careers_checked_at timestamptz;
alter table companies add column if not exists careers_status text;      -- found | none_found | unreachable

-- Cost control. A careers page is only re-read when its fingerprint changes, and we remember
-- per company whether a plain fetch was enough.
alter table companies add column if not exists careers_fingerprint text;
alter table companies add column if not exists careers_needs_browser boolean default false;
alter table companies add column if not exists last_jobs_crawl_at timestamptz;
alter table companies add column if not exists jobs_crawl_status text;

create index if not exists companies_tier_idx on companies (workspace_id, tier);
create index if not exists companies_country_idx on companies (workspace_id, country);
create index if not exists companies_crawl_idx on companies (workspace_id, tier, last_jobs_crawl_at);

-- ---------------------------------------------------------------- job posts
-- A posting found on a company's own careers page has no lead until a recruiter wants one,
-- so job_posts.lead_id must be optional and company_id becomes the anchor.
alter table job_posts alter column lead_id drop not null;
alter table job_posts add column if not exists company_id uuid references companies(id) on delete cascade;
alter table job_posts add column if not exists title text;
alter table job_posts add column if not exists description text;
alter table job_posts add column if not exists first_seen_at timestamptz default now();
alter table job_posts add column if not exists last_seen_at timestamptz default now();
alter table job_posts add column if not exists status text default 'open';
alter table job_posts add column if not exists via text;                 -- ats | http | rss | browser
alter table job_posts add column if not exists is_trade boolean;         -- Haiku's title-only verdict
alter table job_posts add column if not exists classified_at timestamptz;

create unique index if not exists job_posts_company_source_uidx on job_posts (company_id, source_url);
create index if not exists job_posts_company_idx on job_posts (company_id, status);

-- ---------------------------------------------------------------- cost log
-- Every model call and hosted-browser session, so a day can be priced and capped.
create table if not exists cost_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id),
  day date not null default (now() at time zone 'utc')::date,
  kind text not null,                    -- haiku | sonnet | browser | fetch
  detail text,
  units numeric default 0,               -- tokens, or seconds of browser
  eur numeric default 0,
  created_at timestamptz default now()
);
create index if not exists cost_log_day_idx on cost_log (workspace_id, day);
alter table cost_log enable row level security;
create policy ws_cost_log on cost_log for all using (workspace_id = my_workspace());

-- ---------------------------------------------------------------- geography
-- Europe = EU + UK + Norway + Iceland + Switzerland. Anything else is stored but never
-- crawled and cannot reach Today.
create or replace function is_european(cc text) returns boolean language sql immutable as $$
  select upper(coalesce(cc,'')) = any (array[
    'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU',
    'MT','NL','PL','PT','RO','SK','SI','ES','SE',        -- EU 27
    'GB','UK','NO','IS','CH'                             -- UK, Norway, Iceland, Switzerland
  ])
$$;

create or replace function is_priority(cc text) returns boolean language sql immutable as $$
  select upper(coalesce(cc,'')) = any (array['DK','NO','SE','NL','BE','DE','GB','UK','IE','ES','FR','PL','FI'])
$$;

-- Leads carry the same gate, so a non-European project can never surface in Today.
alter table leads add column if not exists country text;
alter table leads add column if not exists region text;
