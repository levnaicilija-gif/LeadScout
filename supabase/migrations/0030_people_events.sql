-- 0030 — one attendee, every event they were seen at.
--
-- people holds attendee-list rows: 12,582 from the WindEurope Copenhagen list (scripts/seed.ts). The WindEurope
-- Annual Event 2026 list (Madrid) holds many of the same people. A second row per person would double every
-- attendee lookup and split one person's history across two rows, so a person already on file keeps their row
-- and gains the new sighting instead (scripts/import-attendees.ts, matching on name + canonical company).
--
--   seen_at_events  every list this person appears on, oldest first; `source` stays the list that first added them
--   title_history   earlier titles, when a later list gives a different one: [{title, source, replaced_at}].
--                   The row's title is the most recent list's; nothing is silently overwritten.
--   is_test         probe rows, like every other table's is_test
--
-- No policy changes: people keeps 0001's ws_people.

alter table people add column if not exists seen_at_events text[] not null default '{}';
alter table people add column if not exists title_history jsonb not null default '[]'::jsonb;
alter table people add column if not exists is_test boolean not null default false;

-- Every existing row was seen at the list that added it.
update people set seen_at_events = array[source] where seen_at_events = '{}';

create index if not exists people_workspace_name_idx on people (workspace_id, lower(name));
