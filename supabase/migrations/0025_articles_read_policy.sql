-- 0025 — the articles and attendee-list people behind a workspace's leads, readable by that workspace.
--
-- Found 2026-09-13 while building queue item 17: a signed-in user of the real workspace read 0 of
-- 605 articles, 0 of 141 lead_articles rows and 0 of 146 lead_people rows, with no error, while the
-- service role read all of them. Row level security is on for all three and none has a policy — no
-- migration enables it for them, so it was switched on outside the migrations. Every screen reading
-- them as the user saw nothing: no "+N sources" on Leads, no "Also reported" in the drawer, no
-- "N from attendee list", and every lead's age unknown. The jobs that write them run as the service
-- role and never noticed. scripts/rls-sweep.ts found lead_people by checking every table at once.
--
-- Read only. These rows are written by jobs, never by a signed-in user. A story that backs no lead
-- (Radar's rejections) stays visible to the service role alone.

alter table articles      enable row level security;
alter table lead_articles enable row level security;
alter table lead_people   enable row level security;

create index if not exists lead_articles_article_idx on lead_articles (article_id);

drop policy if exists ws_lead_articles on lead_articles;
create policy ws_lead_articles on lead_articles for select
  using (lead_id in (select id from leads where workspace_id = my_workspace()));

drop policy if exists ws_articles on articles;
create policy ws_articles on articles for select
  using (id in (select la.article_id from lead_articles la join leads l on l.id = la.lead_id where l.workspace_id = my_workspace()));

drop policy if exists ws_lead_people on lead_people;
create policy ws_lead_people on lead_people for select
  using (lead_id in (select id from leads where workspace_id = my_workspace()));
