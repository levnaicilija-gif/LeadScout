'use client';
import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/client';

/**
 * Clears the Supabase session and leaves with a full page load, so the middleware and the
 * server layout both read the cleared cookie on the way to /login.
 */
export function SignOut() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={async () => { setBusy(true); await supabaseBrowser().auth.signOut(); window.location.href = '/login'; }}
      disabled={busy}
      className="text-left w-full px-2.5 py-2 rounded text-raildim text-[13px] hover:bg-white/5 hover:text-railink"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
