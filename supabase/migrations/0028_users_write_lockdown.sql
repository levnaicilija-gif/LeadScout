-- 0028 — a signed-in user can no longer change who they are, where they belong, or anyone else.
--
-- Found 2026-09-14 while planning queue item 18, which stores a preference on users. 0001's only policy
-- on users is
--   create policy ws_users on users for all using (id = auth.uid() or workspace_id = my_workspace());
-- with no WITH CHECK, so the same test decides both which rows may be written and what they may become.
-- Proven on the live database on 2026-09-14 with throwaway accounts only, each created in its own new
-- workspace, signed in with the public key, and every one removed afterwards (scripts/users-policy-probe.ts):
--   1. A changed its own role, senior → recruiter → senior.
--   2. A set its own workspace_id to B's workspace, and could then read B's workspace, which it could
--      not before. Any account — a fresh sign-up included — could join any workspace whose id it knows.
--   3. A, now in B's workspace, renamed B.
--   4. A recruiter changed a teammate's role, recruiter → senior.
--   5. A recruiter changed a teammate's onboarding_day, 1 → 10, which unlocks every screen early.
--   6. A recruiter deleted a teammate's users row, which locks that person out of the app.
-- At the time the real database held one workspace and one account, a senior, so nothing had been
-- exploited; the exposure opened the moment a second account existed.
--
-- Nothing in the app writes users as a signed-in user: every change of role, workspace or onboarding
-- day goes through the service role. So signed-in users lose all write access to users; reading
-- yourself and your workspace's people stays exactly as it was. Item 18 will grant update on its own
-- preference column alone, and the self-only update policy below is what will guard that column.

drop policy if exists ws_users on users;

-- Read: yourself, and the people in your workspace — unchanged.
drop policy if exists users_read on users;
create policy users_read on users for select
  using (id = auth.uid() or workspace_id = my_workspace());

-- Update: your own row only, and it must stay yours and stay in the workspace it is already in.
-- my_workspace() reads the stored row, so a new workspace_id cannot pass this check.
drop policy if exists users_update_self on users;
create policy users_update_self on users for update
  using (id = auth.uid())
  with check (id = auth.uid() and workspace_id = my_workspace());

-- And no column may be written at all until a later migration grants one by name. Role, workspace and
-- onboarding day are the service role's to set. There is no insert or delete policy: rows are created by
-- handle_new_user (security definer) and removed by the cascade from auth.users.
revoke insert, update, delete on users from anon, authenticated;
