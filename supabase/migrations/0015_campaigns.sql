-- Campaigns: a batch of people going to one client for one scope, and the documents each of
-- them must have before they can travel.
--
-- The point is the gap. A campaign that starts in three weeks with four people missing a medical
-- is the most urgent thing on a recruiter's desk, and until now nothing surfaced it.

-- 'contract' became a document type in 0010 but never reached the enum the required-docs list
-- is built from, so a campaign could not require one.
do $$ begin
  alter type doc_type add value if not exists 'contract';
exception when duplicate_object then null; end $$;

alter table campaigns add column if not exists site text;
alter table campaigns add column if not exists country text;
alter table campaigns add column if not exists notes text;
alter table campaigns add column if not exists created_by uuid references users(id);
alter table campaigns add column if not exists created_at timestamptz default now();

-- Why this person is on this campaign, and where they have got to.
alter table campaign_candidates add column if not exists added_by uuid references users(id);
alter table campaign_candidates add column if not exists added_at timestamptz default now();

create index if not exists campaigns_active_idx on campaigns (workspace_id, status, starts_on);
create index if not exists campaign_candidates_cand_idx on campaign_candidates (candidate_id);

-- A document counts as held when the candidate has one of that type on file. Expiry is checked
-- separately: a medical that ran out last month is not a medical.
create or replace function campaign_missing_docs(p_campaign uuid)
returns table (candidate_id uuid, reference_code text, full_name text, missing doc_type[])
language sql stable as $$
  select c.id, c.reference_code, c.full_name,
         array(
           select d
             from unnest(cp.required_docs) as d
            where not exists (
              select 1 from documents doc
               where doc.candidate_id = c.id
                 and doc.type = d
            )
         ) as missing
    from campaign_candidates cc
    join campaigns cp on cp.id = cc.campaign_id
    join candidates c on c.id = cc.candidate_id
   where cc.campaign_id = p_campaign
$$;
