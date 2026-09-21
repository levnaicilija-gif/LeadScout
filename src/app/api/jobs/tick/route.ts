import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/server';
import { runInBackground } from '@/lib/chain';
import { cronAuthorised } from '@/lib/jobs/cron-auth';
import { runTick, type TickSource, type TickUnit } from '@/lib/jobs/tick';
export const maxDuration = 300;

/**
 * The crawls' schedule (src/lib/jobs/tick.ts): Supabase pg_cron every five minutes (0029), Vercel cron at 04:05.
 *
 *   ?dry=1               what is due, nothing run
 *   ?unit=job-posts      only that crawl        ?force=1  one batch even when it is not due
 *   ?max=1               at most that many batches          ?wait=1  answer with the result
 */
// Every unit the tick knows. A name missing here is silently ignored by `UNITS.find` below and the
// tick then runs EVERYTHING — so ?unit=job-boards would have quietly meant "the whole schedule".
const UNITS: TickUnit[] = ['radar', 'discovery', 'job-posts', 'job-boards'];

export const GET = (req: Request) => {
  if (!cronAuthorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const url = new URL(req.url);
  const p = url.searchParams;
  const source: TickSource = req.headers.get('x-tick-source') === 'pg_cron' ? 'pg_cron'
    : (req.headers.get('user-agent') ?? '').startsWith('vercel-cron') ? 'vercel_cron' : 'manual';
  const unit = UNITS.find((u) => u === p.get('unit'));
  const opts = { source, origin: url.origin, dryRun: p.get('dry') === '1', unit, force: p.get('force') === '1', maxBatches: p.get('max') ? Number(p.get('max')) : undefined };
  const work = async () => NextResponse.json(await runTick(supabaseAdmin(), opts));
  return opts.dryRun ? work() : runInBackground(req, work);
};
export const POST = GET;
