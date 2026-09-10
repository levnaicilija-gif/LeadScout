-- Job boards as a secondary source, with the poster recorded.
--
-- A company's own careers page is the primary signal: it is unambiguous about who is hiring. A
-- board is secondary because the same vacancy appears on it two or three times, placed by
-- agencies competing for the same fee, and an advert that says "Leading offshore contractor"
-- names nobody at all.
--
-- So a board posting carries who placed it and who it is for, separately. They are frequently
-- not the same company, and treating them as one is how a competitor's advert becomes a lead.

alter table job_posts add column if not exists source_id uuid references sources(id);
alter table job_posts add column if not exists poster_name text;        -- who placed the advert
alter table job_posts add column if not exists poster_confidence text;  -- stated | inferred | unknown
alter table job_posts add column if not exists is_secondary boolean default false;
alter table job_posts add column if not exists duplicate_of uuid references job_posts(id) on delete set null;

-- A board posting has no company_id when the employer is not named, so the careers-page unique
-- index cannot cover it. The URL is the identity.
--
-- Dedupe FIRST. This migration failed on its first run against a database that already held the
-- same source_url twice, because AF Gruppen existed as two company rows and the crawl wrote the
-- vacancy under each. A unique index added to live data has to make the data unique itself —
-- leaving that to the person applying it turns a migration into an incident.
--
-- The survivor is the oldest row, so first_seen_at keeps meaning what it says, and anything
-- pointing at a loser is moved across before it goes.
with ranked as (
  select id, source_url,
         row_number() over (partition by source_url order by first_seen_at nulls last, id) as rn
  from job_posts
),
losers as (select id, source_url from ranked where rn > 1),
keepers as (select id, source_url from ranked where rn = 1)
update job_posts jp
   set duplicate_of = k.id
  from losers l
  join keepers k on k.source_url = l.source_url
 where jp.id = l.id;

-- Re-point anything that referenced a loser, then delete it.
update job_posts set duplicate_of = null
 where duplicate_of in (select id from job_posts where duplicate_of is not null);

delete from job_posts jp
 using (
   select id, row_number() over (partition by source_url order by first_seen_at nulls last, id) as rn
     from job_posts
 ) r
 where jp.id = r.id and r.rn > 1;

create unique index if not exists job_posts_source_url_uidx on job_posts (source_url);

create index if not exists job_posts_secondary_idx on job_posts (status, is_secondary);
create index if not exists job_posts_poster_idx on job_posts (poster_type, status);
