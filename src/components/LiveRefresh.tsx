'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-reads the page every few minutes while somebody is looking at it (Today, 2026-09-17).
 *
 * Today's "Since HH:MM" window is the only live thing in the app: a tender award that lands at
 * 14:12 should appear without the recruiter thinking to reload. Everything else here is a server
 * component, so this asks Next to re-render rather than fetching anything itself — one route
 * refresh, no second copy of any query.
 *
 * It stops while the tab is hidden. A laptop left open on Today overnight would otherwise re-read
 * the whole page every five minutes until morning, and each refresh runs Today's six queries.
 */
export function LiveRefresh({ minutes = 5, hook }: { minutes?: number; hook?: string }) {
  const r = useRouter();
  const [last, setLast] = useState<string>('');

  useEffect(() => {
    const every = Math.max(1, minutes) * 60_000;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      r.refresh();
      setLast(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
    };
    const start = () => { if (!timer) timer = setInterval(tick, every); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };

    // A tab brought back after an hour asleep should catch up at once, not wait out the interval.
    const onVisible = () => { if (document.visibilityState === 'visible') { tick(); start(); } else stop(); };

    start();
    document.addEventListener('visibilitychange', onVisible);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisible); };
  }, [minutes, r]);

  return (
    <span data-live-refresh={hook ?? 'today'} className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-0.5 text-[10px] font-bold text-[#6FCBEF]">
      <span className="h-1.5 w-1.5 rounded-full bg-[#6FCBEF] motion-safe:animate-pulse" />
      Live — checking every {minutes} min while you&apos;re here{last ? ` · ${last}` : ''}
    </span>
  );
}
