-- Store the certificate rows exactly as the issuer's register printed them, so the
-- scope/level cross-checks (and any later dispute) can point at the fetched page.
alter table verifications add column if not exists source_rows jsonb default '[]'::jsonb;
