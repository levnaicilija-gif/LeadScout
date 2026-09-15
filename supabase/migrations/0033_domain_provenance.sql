-- 0033 — where a company's website came from, whether it was checked against the award notice, and whether it is the
-- winning entity's own site or its group's; and how many times a lookup has been tried.
--
--   domain_source            how the domain was found: 'web search' today; null for domains set before this migration
--                            by the award notice, a registry, a seed file or a page
--   domain_source_url        the page the lookup read that names the company
--   domain_checked_address   the award notice's address the site was checked against, e.g. '16260 Chasseneuil-Sur-Bonnieure'
--   domain_address_check     'printed'           the site's home page or a contact / imprint page prints that postcode or town
--                            'not_printed'       it does not — the site may be right, but it is not confirmed
--                            'site_did_not_load' the check could not read the site
--                            'no_address'        the notice printed no address for the winner, so nothing to check
--   domain_scope             'own' | 'group' — src/lib/site-scope.ts: the winner's own site, or its group's (colas.com for
--                            COLAS FRANCE), where a switchboard reaches the group, not the operation that won
--   domain_scope_reason      one sentence saying why 'group'
--   domain_lookups           lookups tried; a miss is final (careers_status 'no_domain_found') only after the second,
--                            because the lookup is not deterministic — ANDRES VIZOSO was found as vizoso.net once and
--                            missed the next time (2026-09-15)
--   domain_looked_up_at      the last lookup
--
-- Until 2026-09-15 a website search wrote its result over companies.source and source_url, so the record of where a
-- company came from (a TED award notice, a Radar story) was lost for every company it resolved. That record goes back
-- below, from the company's own lead; the search's result moves to these columns.

alter table companies add column if not exists domain_source text;
alter table companies add column if not exists domain_source_url text;
alter table companies add column if not exists domain_checked_address text;
alter table companies add column if not exists domain_address_check text;
alter table companies add column if not exists domain_scope text;
alter table companies add column if not exists domain_scope_reason text;
alter table companies add column if not exists domain_lookups int not null default 0;
alter table companies add column if not exists domain_looked_up_at timestamptz;

alter table companies drop constraint if exists companies_domain_address_check_values;
alter table companies add constraint companies_domain_address_check_values
  check (domain_address_check is null or domain_address_check in ('printed', 'not_printed', 'site_did_not_load', 'no_address'));
alter table companies drop constraint if exists companies_domain_scope_values;
alter table companies add constraint companies_domain_scope_values
  check (domain_scope is null or domain_scope in ('own', 'group'));

-- 1. The won-work lookups of 2026-09-15 wrote 'web search · <check>' into source: move the check and the page across.
update companies set
  domain_source = 'web search',
  domain_source_url = source_url,
  domain_address_check = case
    when source = 'web search · address printed on the site' then 'printed'
    when source = 'web search · address not printed on the site' then 'not_printed'
    when source = 'web search · site did not load for the address check' then 'site_did_not_load'
    when source = 'web search · no address in the notice' then 'no_address'
  end,
  domain_lookups = greatest(domain_lookups, 1),
  domain_looked_up_at = coalesce(domain_looked_up_at, now())
where source like 'web search · %' and domain is not null;

-- 2. Earlier resolve-domains runs wrote plain 'web search'.
update companies set domain_source = 'web search', domain_source_url = source_url, domain_lookups = greatest(domain_lookups, 1)
where source = 'web search' and domain is not null and domain_source is null;

-- 3. Where the company came from, restored from its oldest lead: a TED award notice, else a Radar story.
update companies c set source = 'ted award notice', source_url = l.notice
from (
  select distinct on (company_id) company_id, split_part(source_url, '#', 1) as notice
  from leads where source_url like 'https://ted.europa.eu/%' and company_id is not null
  order by company_id, created_at
) l
where c.id = l.company_id and c.source like 'web search%';

update companies c set source = 'radar article', source_url = l.source_url
from (
  select distinct on (company_id) company_id, source_url
  from leads where source_url is not null and source_url not like 'https://ted.europa.eu/%' and company_id is not null
  order by company_id, created_at
) l
where c.id = l.company_id and c.source like 'web search%';

-- 4. Every company marked "no website" after a single lookup gets the one retry the rule now allows.
update companies set domain_lookups = greatest(domain_lookups, 1), careers_status = null
where careers_status = 'no_domain_found' and domain is null;
