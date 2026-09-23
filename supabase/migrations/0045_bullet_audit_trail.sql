-- 0045 — what the bullet audit actually did, recorded rather than thrown away.
--
-- WHY. buildBullets writes three client bullets, audits them against the candidate's own data, and
-- rewrites any it cannot trace — up to three rounds, then it drops the ones still unsupported. Two
-- true bullets beat three with a lie. It is the guard that stops an invented line reaching a client,
-- and it is also the single slowest thing in a CV drop: 52 s of the 116 s measured on 2026-09-22.
--
-- The obvious saving is to cap it at two rounds. That was measured over 295 runs and the third round
-- runs in 6% of them — but WHETHER THOSE 6% ARE THE ONES WHERE IT EARNS ITS KEEP COULD NOT BE
-- ANSWERED, because the outcome was never recorded: `dropped` is returned to the browser and
-- forgotten, and only 4 anonymized_cvs rows survive probe cleanup. So the guard was left alone
-- (owner's decision, 2026-09-23) and this migration starts recording what already happens, so the
-- question can be asked again from real use rather than from four rows.
--
-- WHAT THE TWO EXITS LOOK LIKE, which is what makes these columns sufficient. buildBullets returns
-- from INSIDE its loop the moment an audit finds nothing bad, leaving `dropped` empty; it falls out
-- of the loop only when the third audit still finds bad bullets, and those go into `dropped`. So
-- `bullets_dropped` already distinguishes satisfied from exhausted — what it cannot say is how many
-- rounds it took, since a clean run looks identical at one round or three. `bullet_rounds` supplies
-- exactly that, and together they answer the question by counting:
--
--   rounds 1, dropped empty      clean first time                     (74% of runs today)
--   rounds 2, dropped empty      the second round fixed it            (20%)
--   rounds 3, dropped empty      THE THIRD ROUND CAUGHT IT            <- the question
--   rounds 3, dropped non-empty  exhausted; the third round did not   <- its complement
--
-- NULLABLE AND NOT BACKFILLED, deliberately. The rows already on file genuinely have no recorded
-- round count, and null must read as "not recorded" and never as zero: a `default 0` would claim
-- every historic run finished in no rounds at all and poison the first week of real numbers.
--
-- NO BEHAVIOUR CHANGE. Nothing reads these columns; nothing decides anything differently. The audit
-- runs exactly as it did, and this writes down what it did.

alter table anonymized_cvs add column if not exists bullet_rounds smallint;
alter table anonymized_cvs add column if not exists bullets_dropped text[];
alter table anonymized_cvs add column if not exists bullet_audit jsonb;

comment on column anonymized_cvs.bullet_rounds is
  'How many audit rounds buildBullets ran (1-3). Null means not recorded, never zero.';
comment on column anonymized_cvs.bullets_dropped is
  'Bullets the audit could not trace to the candidate data after the last round, so they were dropped. Empty means the audit was satisfied; non-empty means it was exhausted.';
comment on column anonymized_cvs.bullet_audit is
  'Per round: how many bullets the audit rejected, e.g. [{"round":1,"bad":2},{"round":2,"bad":0}]. Shows whether a rewrite converges or keeps failing the same way.';
