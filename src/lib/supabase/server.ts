import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { steadyUser } from './steady-user';

export function supabaseServer() {
  const store = cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: { get: (n: string) => store.get(n)?.value, set: (n: string, v: string, o: any) => { try { store.set({ name: n, value: v, ...o }); } catch {} }, remove: (n: string, o: any) => { try { store.set({ name: n, value: '', ...o }); } catch {} } },
  });
}
/**
 * Service role — server only, for jobs and the public /v page. Never import in client code.
 *
 * Every query goes out with `cache: 'no-store'`. Next caches fetches by default, and supabase-js
 * runs on fetch, so a query made once got its answer frozen in the Data Cache — which survives
 * deployments. /v/rfbt-f-0009 kept reporting no client version for that candidate long after one
 * existed, because the empty answer from before it was created was still being served. Database
 * reads are not static assets; none of them may come from a cache.
 */
export function supabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
    global: { fetch: (url: any, init: any = {}) => fetch(url, { ...init, cache: 'no-store' }) },
  });
}
/**
 * null means "not signed in" and nothing else. If there IS a session but the profile row
 * cannot be read, that is a server fault and must throw: returning null there sends a
 * signed-in recruiter back to /login with no message, which is how the RLS recursion in
 * my_workspace() hid itself (migration 0003).
 */
export async function currentUser() {
  return (await userOrWhy()).me;
}

/**
 * The signed-in user for a screen, or a redirect to /login that says why.
 *
 * The middleware labels its own redirects (`x-signin-reason`), but a screen's redirect said nothing. On 2026-09-14/15
 * smoke was sent to /login by the screen itself — the middleware had let the request through — several minutes into a
 * run, straight after the RLS sweep, and the next load was signed in again. The session lives 3,600 s
 * (`scripts/session-length-probe.ts`), so it was not expiry. `?why=` names the auth answer the screen got.
 */
export async function requireUser() {
  const { me, why, failed } = await userOrWhy();
  // The auth server could not be asked (it answered `?why=page: AuthRetryableFetchError 0` on 2026-09-15, six times
  // over now). That is not a sign-out, so it does not send the person to sign in: it says what happened.
  if (!me && failed) throw new Error(`The sign-in service could not be reached (${why}). You are still signed in — reload the page.`);
  if (!me) redirect(`/login?why=${encodeURIComponent(`page: ${why}`)}`);
  return me;
}

async function userOrWhy() {
  const sb = supabaseServer();
  // A failed auth check is not "not signed in" either: it is asked again first.
  const { user, reason, failed } = await steadyUser(sb);
  if (!user) return { me: null, why: reason, failed };
  const { data, error } = await sb.from('users').select('*').eq('id', user.id).maybeSingle();
  if (error) throw new Error(`Signed in as ${user.email} but the users row could not be read: ${error.code} ${error.message}`);
  if (!data) throw new Error(`Signed in as ${user.email} but no users row exists — the sign-up trigger did not run.`);
  return { me: { ...data, email: user.email }, why: '', failed: false };
}
