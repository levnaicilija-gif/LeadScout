-- 0031 — item 18 part 2: the industries a lead or a company belongs to, and the words that put it there.
--
-- Classified by src/lib/industry.ts, with no model call: an award notice by its CPV codes (item 12's confirmed
-- list only), a news story by words in its title, project name and opening prose (a site's own repeated lines
-- and a company's paragraph about itself do not count), a Hiring now company by its advert titles and the quoted
-- words of its employer-type evidence. A company also carries the industries of its open leads.
--
--   industries          the category ids, several when several apply; ['other'] when none does
--   industry_evidence   [{industry, via: 'cpv' | 'words', term, where}] — every tag with what made it
--   industries_at       when it was classified; null means not yet, which is not the same as 'other'
--
-- No policy changes: leads and companies keep their workspace policies, which cover these columns.

alter table leads add column if not exists industries text[] not null default '{}';
alter table leads add column if not exists industry_evidence jsonb not null default '[]'::jsonb;
alter table leads add column if not exists industries_at timestamptz;

alter table companies add column if not exists industries text[] not null default '{}';
alter table companies add column if not exists industry_evidence jsonb not null default '[]'::jsonb;
alter table companies add column if not exists industries_at timestamptz;

create index if not exists leads_industries_idx on leads using gin (industries);
create index if not exists companies_industries_idx on companies using gin (industries);
