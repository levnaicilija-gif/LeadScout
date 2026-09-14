import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';

/**
 * Batch jobs that chain on Vercel — Radar, careers discovery, the job-post crawl.
 *
 * Each batch used to pass the next one on with a fetch it abandoned after 1.5 seconds, then did its own
 * work. On Vercel that abandoned request did not survive: every scheduled morning from 11 to 14 September
 * 2026, Radar read its first batch of 5 of the 52 priority sources and stopped, and the job crawl and
 * careers discovery that the nightly recheck starts never ran on their own after 10 September.
 *
 *   runInBackground  an authorised batch answers 202 at once and does its work inside waitUntil, within the
 *                    same 300 s maxDuration it always had. ?wait=1 runs it inline and returns the full
 *                    result, for a person or a script that wants to read it.
 *   handOff          passes the next batch on without ?wait, so that batch answers at once too, and says
 *                    whether it was accepted. A refused or unanswered hand-off is returned, never swallowed.
 *
 * No time budget nests: a parent waits seconds for a 202, never for its child's work.
 */
export function runInBackground(req: Request, work: () => Promise<Response>): Response | Promise<Response> {
  if (new URL(req.url).searchParams.get('wait') === '1') return work();
  const path = new URL(req.url).pathname;
  waitUntil(work().then(() => undefined, (e) => console.error(`[background batch] ${path} failed:`, e)));
  return NextResponse.json({ accepted: true, running: 'in the background — add ?wait=1 to wait for the result' }, { status: 202 });
}

/** Hand the next batch to a fresh invocation. Returns why it was not accepted, or null when it was. */
export async function handOff(url: string, timeoutMs = 15_000): Promise<string | null> {
  const u = new URL(url);
  u.searchParams.delete('wait');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(u.toString(), { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET ?? '' }, signal: ac.signal, cache: 'no-store' });
    return r.status === 202 || r.ok ? null : `the next batch was refused: HTTP ${r.status}`;
  } catch (e: any) {
    return e?.name === 'AbortError'
      ? `the next batch did not answer within ${Math.round(timeoutMs / 1000)} s`
      : `the next batch could not be reached: ${String(e?.message ?? e).slice(0, 120)}`;
  } finally {
    clearTimeout(timer);
  }
}
