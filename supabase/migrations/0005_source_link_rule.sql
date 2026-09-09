-- Per-source crawl rule, so a site can be fixed without a deploy. Either a bare regex tested
-- against the article pathname, or JSON: {"index":"...","pattern":"...","browser":true}.
-- Built-in rules for known sites live in src/lib/source-rules.ts; this column overrides them.
alter table sources add column if not exists link_rule text;
