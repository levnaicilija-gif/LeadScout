'use client';
import { useEffect, useState } from 'react';

/**
 * Tells the server the recruiter is here, once per page load, and nothing else.
 *
 * Today renders with the PREVIOUS visit's boundary and this advances it afterwards, which is the only
 * order that works: the page must read the old stamp to know what arrived while they were out, so the
 * write cannot happen before the read. The 30-minute rule lives in visitWindow and is applied by the
 * route, so a reload inside the same visit posts and writes nothing.
 *
 * The state is on the element (`data-visit-stamp`) because this write failed silently for four days
 * and nothing on screen or in any probe could see it: "advanced" and "same" are both successes,
 * "failed" is the one that used to be invisible.
 */
export function VisitStamp() {
  const [state, setState] = useState<'pending' | 'advanced' | 'same' | 'failed'>('pending');
  useEffect(() => {
    let alive = true;
    fetch('/api/me/visit', { method: 'POST' })
      .then(async (r) => {
        const body = await r.json().catch(() => ({} as any));
        if (alive) setState(r.ok ? (body?.advanced ? 'advanced' : 'same') : 'failed');
      })
      .catch(() => { if (alive) setState('failed'); });
    return () => { alive = false; };
  }, []);
  return <span data-visit-stamp={state} className="hidden" aria-hidden="true" />;
}
