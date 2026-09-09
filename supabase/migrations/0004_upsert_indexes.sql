-- Radar creates leads but no contacts, which is the whole point of the module: a lead with
-- a sourced, quoted decision-maker.
--
-- upsertWonLead() upserts contacts with onConflict 'lead_id,name' and upsertJobLead() upserts
-- leads with onConflict 'source_url'. PostgREST needs a unique index behind each of those, and
-- neither existed, so every contact write failed. It failed silently because the result was
-- never checked — the route now checks it too.
create unique index if not exists contacts_lead_name_uidx on contacts (lead_id, name);

-- Leads are deduped on the article/posting they came from. Nulls stay allowed: a lead created
-- by hand has no source_url, and Postgres treats each null as distinct.
create unique index if not exists leads_source_url_uidx on leads (source_url);
