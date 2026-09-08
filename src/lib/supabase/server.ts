import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';

export function supabaseServer() {
  const store = cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: { get: (n: string) => store.get(n)?.value, set: (n: string, v: string, o: any) => { try { store.set({ name: n, value: v, ...o }); } catch {} }, remove: (n: string, o: any) => { try { store.set({ name: n, value: '', ...o }); } catch {} } },
  });
}
/** Service role — server only, for jobs and the public /v page. Never import in client code. */
export function supabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}
/**
 * null means "not signed in" and nothing else. If there IS a session but the profile row
 * cannot be read, that is a server fault and must throw: returning null there sends a
 * signed-in recruiter back to /login with no message, which is how the RLS recursion in
 * my_workspace() hid itself (migration 0003).
 */
export async function currentUser() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data, error } = await sb.from('users').select('*').eq('id', user.id).maybeSingle();
  if (error) throw new Error(`Signed in as ${user.email} but the users row could not be read: ${error.code} ${error.message}`);
  if (!data) throw new Error(`Signed in as ${user.email} but no users row exists — the sign-up trigger did not run.`);
  return { ...data, email: user.email };
}
