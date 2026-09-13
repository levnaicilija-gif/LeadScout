import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/server';
import { ingestTedAwards, tedWindowFor } from '@/lib/tender/ingest';
export const maxDuration = 300;

/**
 * Contract awards from TED, on demand. The daily run rides Radar's cron (see the radar route);
 * this is the same pass for a manual run or a backfill.
 *
 *   POST /api/jobs/tenders                         since the newest stored notice
 *   POST /api/jobs/tenders?from=2026-09-01&to=2026-09-13
 *   POST /api/jobs/tenders?dry=1                   read and match, write nothing
 *
 * Same auth as every job: the Vercel cron's bearer or x-cron-secret, on both verbs.
 */
const authorised = (req: Request) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('x-cron-secret') === secret || req.headers.get('authorization') === `Bearer ${secret}`;
};

export const GET = (req: Request) => run(req);
export const POST = (req: Request) => run(req);

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const params = new URL(req.url).searchParams;
  const auto = await tedWindowFor(db);
  const from = params.get('from') ?? auto.from;
  const to = params.get('to') ?? auto.to;
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(from) || !day.test(to) || from > to) return NextResponse.json({ error: `from and to must be YYYY-MM-DD with from <= to (got ${from}, ${to})` }, { status: 400 });

  const report = await ingestTedAwards(db, { from, to, deadlineAt: Date.now() + 270_000, dryRun: params.get('dry') === '1' });
  console.log(`[tenders] ${from}..${to} notices=${report.noticesChecked}/${report.noticesInWindow} awards=${report.awardsMatched} leads=${report.leadsCreated} companies=${report.companiesCreated}+${report.companiesMatched} errors=${report.errors} stoppedEarly=${report.stoppedEarly}`);
  return NextResponse.json({ ok: true, ...report });
}
