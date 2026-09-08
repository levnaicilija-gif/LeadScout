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
export async function currentUser() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data } = await sb.from('users').select('*').eq('id', user.id).single();
  return data ? { ...data, email: user.email } : null;
}
