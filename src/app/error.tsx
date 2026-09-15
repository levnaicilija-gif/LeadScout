'use client';
import Link from 'next/link';
import { useEffect } from 'react';

/**
 * What a screen shows when it fails, instead of Next's bare "Application error: a server-side exception has occurred".
 *
 * Found 2026-09-15: when the sign-in service does not answer, requireUser throws "The sign-in service could not be
 * reached … reload the page" so a signed-in recruiter is not sent to /login — but a production build strips a server
 * error's message, and with no boundary anywhere the recruiter saw only the bare error page. This boundary sits at the
 * root segment, so it also catches the /app and rail layouts, where requireUser runs (a segment's own error.tsx does not
 * catch its own layout). The message cannot say why — production hides it — so it says what to do, and gives the digest
 * the server log carries, so a repeat can be traced.
 */
export default function ScreenError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main data-error-boundary className="min-h-screen bg-bg grid place-items-center px-4 py-10">
      <div className="w-full max-w-[460px] bg-panel border border-line rounded-card px-6 py-7">
        <h1 className="font-display text-[22px] leading-tight font-extrabold m-0 text-ink">Something went wrong — reload the page</h1>
        <p className="text-ink2 text-[14px] mt-2.5 mb-0">This screen could not be loaded. It is usually brief, and reloading fixes it. If it keeps happening, send the reference below to whoever runs LeadScout.</p>
        <div className="flex flex-wrap gap-2.5 mt-5">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload the page</button>
          <Link href="/app/home" className="btn">Go to Home</Link>
        </div>
        {error.digest && <p data-error-reference className="text-ink3 text-[12px] mt-4 mb-0 break-all">Reference: {error.digest}</p>}
      </div>
    </main>
  );
}
