-- Fix: signing in worked, but every RLS-protected read failed with
-- "54001 stack depth limit exceeded", so the /app layout's currentUser() read returned
-- nothing and bounced the recruiter straight back to /login.
--
-- Cause: my_workspace() selects from users, and the policy on users calls my_workspace(),
-- so the policy recursed into itself. A plain SQL function runs as the caller and is still
-- subject to RLS.
--
-- security definer makes the lookup run as the function owner, outside RLS, which breaks
-- the cycle. search_path is pinned so the definer rights cannot be redirected at another
-- schema's table.
create or replace function my_workspace() returns uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$ select workspace_id from users where id = auth.uid() $$;

revoke execute on function my_workspace() from public;
grant execute on function my_workspace() to authenticated, service_role;
