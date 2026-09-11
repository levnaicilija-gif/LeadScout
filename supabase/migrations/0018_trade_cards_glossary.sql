-- The new-hire path: what a trade actually is, what the words mean, and what a recruiter is
-- allowed to do on each day of their first fortnight.
--
-- A recruiter who does not know that 6G is a pipe position welded in a fixed 45-degree axis
-- cannot read a CV, and will not ask the question that separates a welder who can do it from one
-- who says he can. This content is the difference between reading a CV and understanding it.

create table if not exists trade_cards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id),          -- null = shipped with the product
  trade text not null,                                  -- one of the ten in RFBT_TRADE_LIST
  lang text not null default 'en' check (lang in ('en', 'sr')),
  title text not null,
  what_it_is text,                                      -- what the job actually is, on site
  certificates jsonb default '[]',                      -- [{body, levels, who_requires_it}]
  codes jsonb default '[]',                             -- [{code, means}] — 6G, PF, Sa 2.5
  check_on_cv text[] default '{}',
  red_flags text[] default '{}',
  -- Rates and rotations are deliberately EMPTY. They are commercial facts that change by
  -- country and by month, and inventing them would put a number in a recruiter's mouth on a
  -- client call. A senior fills these in; until then the card says so.
  rates jsonb default '[]',                             -- [{country, unit, low, high, source, noted_at}]
  rotations jsonb default '[]',                         -- [{country, pattern, source}]
  questions jsonb default '[]',                         -- [{q, good_answer}]
  updated_by uuid references users(id),
  updated_at timestamptz default now(),
  unique (workspace_id, trade, lang)
);

create table if not exists glossary (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id),          -- null = shipped with the product
  term text not null,
  lang text not null default 'en' check (lang in ('en', 'sr')),
  category text,                                        -- welding | coating | safety | commercial | contract
  short text not null,                                  -- one line, for the hover
  long text,                                            -- the fuller explanation
  see_also text[] default '{}',
  updated_by uuid references users(id),
  updated_at timestamptz default now(),
  unique (workspace_id, term, lang)
);

create index if not exists trade_cards_trade_idx on trade_cards (trade, lang);
create index if not exists glossary_term_idx on glossary (lower(term), lang);

alter table trade_cards enable row level security;
alter table glossary enable row level security;

-- Everyone reads the shipped content; a workspace only ever sees its own edits.
drop policy if exists rw_trade_cards on trade_cards;
create policy rw_trade_cards on trade_cards for all
  using (workspace_id is null or workspace_id = my_workspace())
  with check (workspace_id = my_workspace());

drop policy if exists rw_glossary on glossary;
create policy rw_glossary on glossary for all
  using (workspace_id is null or workspace_id = my_workspace())
  with check (workspace_id = my_workspace());

-- ---------------------------------------------------------------- onboarding
-- What a recruiter may do on each day of their first fortnight, and what a senior must review.
alter table users add column if not exists onboarding_started_on date default (now() at time zone 'utc')::date;

alter table outreach add column if not exists needs_review boolean default false;
alter table outreach add column if not exists reviewed_by uuid references users(id);
alter table outreach add column if not exists reviewed_at timestamptz;
alter table outreach add column if not exists review_note text;

alter table sends add column if not exists needs_review boolean default false;
alter table sends add column if not exists reviewed_by uuid references users(id);
alter table sends add column if not exists reviewed_at timestamptz;

create index if not exists outreach_review_idx on outreach (needs_review, reviewed_at);
create index if not exists sends_review_idx on sends (needs_review, reviewed_at);
