-- 0021 — where a date came from.
--
-- articles.published_at and job_posts.posted_at were empty on every row (0 of 481, 0 of 38), which
-- left the same-contract rule unable to say which of two sources came first and every lead-age
-- threshold with nothing to measure. They are now filled from the page, and a date read off a
-- structured field is a different kind of claim from a date found in the opening lines of the
-- text — so each one says which it was.
--
-- A date found only in the text is written ONLY once this column exists: without it, a dateline
-- and a JSON-LD field would be indistinguishable, and the code refuses to store that ambiguity.

alter table articles  add column if not exists published_at_source text;  -- e.g. "JSON-LD NewsArticle.datePublished", "dateline in the first 600 characters", "TED publication date"
alter table job_posts add column if not exists posted_at_source text;     -- e.g. "JSON-LD JobPosting.datePosted", "ATS feed (lever createdAt)"
