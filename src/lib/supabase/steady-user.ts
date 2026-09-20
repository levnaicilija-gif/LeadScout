import type { SupabaseClient, User } from '@supabase/supabase-js';

/**
 * The signed-in user, asked twice when the first answer was a failure rather than "nobody".
 *
 * getUser() calls the auth server on every request. When that call fails in transit — a dropped connection, a 5xx,
 * a 429 — it returns no user, and the app used to read that as signed out and send the user to /login. On
 * 2026-09-14 a smoke run was bounced to the sign-in page mid-session and the very next page load was signed in
 * again. A missing or rejected session is still an immediate "nobody"; only a failed check is asked again.
 */
export async function steadyUser(sb: Pick<SupabaseClient, 'auth'>): Promise<{ user: User | null; reason: string; failed: boolean }> {
  // Six tries, about two seconds in all. Three quick ones were not enough: on 2026-09-15 a screen was sent to
  // /login?why=page: AuthRetryableFetchError 0 straight after smoke's RLS sweep while the middleware's own check on the
  // same request had passed — a fetch that never reached the auth server, three times over.
  //
  // WHY THIS LOOP CANNOT FIX THE COMMON CASE (measured 2026-09-20; the sentence that used to sit here, blaming stale
  // kept-alive connections "each retry spends one of", was wrong). Wrapping globalThis.fetch inside `next start`
  // caught the real error: UND_ERR_CONNECT_TIMEOUT, undici failing to complete a NEW TCP handshake to Supabase's
  // Cloudflare addresses inside its 10 s default. There is no stale socket, because no socket is established — and
  // one failed connect takes 10 s, so all six tries here fit inside a single one and none of them gets a turn. The
  // retries still earn their place for a genuine 429 or 5xx, which is why they stay; they are simply not the answer
  // to the connect timeouts that cost six of eleven gates that night. The fix belongs in a configured undici
  // dispatcher (bounded pool, longer connectTimeout), not here. See CLAUDE.md, "The 'auth transient' is not auth".
  for (let attempt = 1; ; attempt++) {
    const { data, error } = await sb.auth.getUser();
    if (data?.user) return { user: data.user, reason: '', failed: false };
    const status = (error as { status?: number } | null)?.status;
    const failedCheck = !!error && (error.name === 'AuthRetryableFetchError' || status === 0 || status === 429 || (status ?? 0) >= 500);
    const reason = error ? `${error.name}${status !== undefined ? ` ${status}` : ''}` : 'no session';
    // `failed`: the auth server could not be asked, which is not the same as nobody being signed in.
    if (!failedCheck || attempt >= 6) return { user: null, reason, failed: failedCheck };
    await new Promise((r) => setTimeout(r, 150 * attempt));
  }
}
