import type { SupabaseClient, User } from '@supabase/supabase-js';

/**
 * The signed-in user, asked twice when the first answer was a failure rather than "nobody".
 *
 * getUser() calls the auth server on every request. When that call fails in transit — a dropped connection, a 5xx,
 * a 429 — it returns no user, and the app used to read that as signed out and send the user to /login. On
 * 2026-09-14 a smoke run was bounced to the sign-in page mid-session and the very next page load was signed in
 * again. A missing or rejected session is still an immediate "nobody"; only a failed check is asked again.
 */
export async function steadyUser(sb: Pick<SupabaseClient, 'auth'>): Promise<{ user: User | null; reason: string }> {
  for (let attempt = 1; ; attempt++) {
    const { data, error } = await sb.auth.getUser();
    if (data?.user) return { user: data.user, reason: '' };
    const status = (error as { status?: number } | null)?.status;
    const failedCheck = !!error && (error.name === 'AuthRetryableFetchError' || status === 0 || status === 429 || (status ?? 0) >= 500);
    const reason = error ? `${error.name}${status !== undefined ? ` ${status}` : ''}` : 'no session';
    if (!failedCheck || attempt >= 3) return { user: null, reason };
    await new Promise((r) => setTimeout(r, 250 * attempt));
  }
}
