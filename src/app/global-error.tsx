'use client';
import './globals.css';
import { useEffect } from 'react';

/**
 * The same message when the root layout itself fails — the one place src/app/error.tsx cannot reach, because it renders
 * inside that layout. It replaces the root layout, so it brings its own <html>, <body> and stylesheet.
 */
export default function RootError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <html lang="en">
      <body className="font-sans text-[14px] leading-[1.45]">
        <main data-error-boundary className="min-h-screen bg-bg grid place-items-center px-4 py-10">
          <div className="w-full max-w-[460px] bg-panel border border-line rounded-card px-6 py-7">
            <h1 className="text-[22px] leading-tight font-extrabold m-0 text-ink">Something went wrong — reload the page</h1>
            <p className="text-ink2 text-[14px] mt-2.5 mb-0">LeadScout could not be loaded. It is usually brief, and reloading fixes it. If it keeps happening, send the reference below to whoever runs LeadScout.</p>
            <div className="flex flex-wrap gap-2.5 mt-5">
              <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload the page</button>
            </div>
            {error.digest && <p data-error-reference className="text-ink3 text-[12px] mt-4 mb-0 break-all">Reference: {error.digest}</p>}
          </div>
        </main>
      </body>
    </html>
  );
}
