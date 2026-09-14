import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';

/**
 * An authorised job batch answers 202 at once and does its work inside waitUntil, within its route's 300 s
 * maxDuration. ?wait=1 runs it inline and returns the full result, for a person or a script that wants it.
 *
 * There is deliberately no hand-off here. Until 2026-09-14 each batch passed the next one on over HTTP: first
 * with a fetch abandoned after 1.5 s, which never survived on Vercel, then with one that waited for this 202.
 * The second started every batch of the run within two seconds, the job crawl's batches picked the same
 * companies, and Vercel refused the fifth hop with 508 INFINITE_LOOP_DETECTED — outbound fetches carry the
 * caller's x-vercel-id, and a function calling its own deployment is capped however it is timed.
 * Batches that must follow each other run inside one tick: src/lib/jobs/tick.ts.
 */
export function runInBackground(req: Request, work: () => Promise<Response>): Response | Promise<Response> {
  if (new URL(req.url).searchParams.get('wait') === '1') return work();
  const path = new URL(req.url).pathname;
  waitUntil(work().then(() => undefined, (e) => console.error(`[background batch] ${path} failed:`, e)));
  return NextResponse.json({ accepted: true, running: 'in the background — add ?wait=1 to wait for the result' }, { status: 202 });
}
