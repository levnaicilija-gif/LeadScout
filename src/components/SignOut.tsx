'use client';
import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/client';

/**
 * Clears the Supabase session and leaves with a full page load, so the middleware and the
 * server layout both read the cleared cookie on the way to /login.
 *
 * Two skins, because it appears on both grounds: the dark rail and Home's white bar.
 */
export function SignOut({ on = 'dark' }: { on?: 'dark' | 'light' }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={async () => { setBusy(true); await supabaseBrowser().auth.signOut(); window.location.href = '/login'; }}
      disabled={busy}
      className={on === 'dark'
        ? 'text-left w-full px-2.5 py-2 rounded text-raildim text-[13px] hover:bg-white/5 hover:text-railink'
        : 'px-2.5 py-1.5 rounded text-ink3 text-[13px] font-medium hover:bg-line2 hover:text-ink whitespace-nowrap'}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
