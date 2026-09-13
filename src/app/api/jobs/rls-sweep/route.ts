import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/server';
import { runRlsSweep, recordRlsSweep, sweepSummary } from '@/lib/rls-sweep';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

/**
 * The RLS sweep on demand, behind the cron secret. src/lib/rls-sweep.ts holds the rules.
 *
 * The nightly run rides /api/jobs/recheck — the plan allows two crons and both are taken. This route
 * is for a manual run, and for smoke, which calls it with ?record=0 so a test run never becomes the
 * result Home shows.
 */
export const GET = (req: Request) => POST(req);

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const authorised = !!secret && (req.headers.get('x-cron-secret') === secret || req.headers.get('authorization') === `Bearer ${secret}`);
  if (!authorised) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  const r = await runRlsSweep();
  const record = new URL(req.url).searchParams.get('record') !== '0';
  const notKept = record ? await recordRlsSweep(supabaseAdmin(), r, 'manual') : 'not asked to record (?record=0)';
  return NextResponse.json({
    ok: r.ok, summary: sweepSummary(r), suspects: r.suspects, unjudged: r.unjudged, catalog: r.catalog, error: r.error,
    tables: r.rows.length, ranAt: r.ranAt, recorded: notKept === null, notRecorded: notKept,
  });
}
