import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/server';
import { fetchPage } from '@/lib/fetch-page';
import { CLOSED_LEAD_STATUSES, LEAD_STATE_EMBED, LEAD_STATE_TABLE } from '@/lib/workspace-state';
import { runLookup } from '@/lib/verify/adapters';
import { leadSource } from '@/lib/lead-source';
import { sourceFlag } from '@/lib/source-quality';
import { hasSourceFlag } from '@/lib/schema-features';
import { runRlsSweep, recordRlsSweep, sweepSummary } from '@/lib/rls-sweep';
export const maxDuration = 300;
/**
 * Nightly: (0) the RLS sweep, recorded for Home (src/lib/rls-sweep.ts);
 * (1) re-fetch lead source pages → live/stale/not_found; (2) re-check certs expiring
 * ≤ 90 days.
 *
 * Careers discovery and the job-post crawl used to be started here and chain themselves onward. The
 * tick runs them now (src/lib/jobs/tick.ts): Vercel refuses a function that keeps calling its own deployment.
 */
export const GET = (req: Request) => POST(req);

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const authorised = !!secret && (req.headers.get('x-cron-secret') === secret || req.headers.get('authorization') === `Bearer ${secret}`);
  if (!authorised) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();

  // The RLS sweep first, before the source re-fetches below. On 2026-09-14 a manual
  // run found why no nightly result was ever kept: the sweep's first request got an HTML gateway page instead
  // of JSON, and storing that failure got "Gateway Timeout". Both now retry (src/lib/rls-sweep.ts). The release
  // gate catches a table a code change or a migration leaves unreadable; only a scheduled run catches one
  // switched on in the Supabase dashboard between commits.
  const sweep = await runRlsSweep();
  const sweepNotKept = await recordRlsSweep(db, sweep, 'cron');
  // Item 20 step 2b: only leads somebody still considers open are re-fetched, read from the state row.
  const { data: leads } = await db.from('leads').select(`id, source_url, kind, created_at, ${LEAD_STATE_EMBED}`).not(`${LEAD_STATE_TABLE}.status`, 'in', CLOSED_LEAD_STATUSES).limit(200);
  const flagOn = await hasSourceFlag(db);
  for (const l of leads ?? []) {
    if (!l.source_url) continue;
    // An award notice is read from the TED API; its web page answers a burst of requests with 429,
    // which would mark every award lead "not found" each night.
    if (leadSource(l.source_url) === 'tender') continue;
    const p = await fetchPage(l.source_url);
    const ageDays = (Date.now() - new Date(l.created_at).getTime()) / 86400000;
    const status = p.status === 'not_found' ? 'not_found' : ageDays > 30 && l.kind === 'job_post' ? 'stale' : 'live';
    // The source's state is flagged; the lead's status is the owner's to set. This used to write
    // status 'stale' on a page that did not load, which hid the lead from Leads and Pitch on the
    // strength of one failed fetch, without anyone deciding it.
    const flag = sourceFlag(p, { requestedUrl: l.source_url });
    await db.from('leads').update({ source_fetch_status: status, source_fetched_at: p.fetchedAt, ...(flagOn ? { source_flag: flag.flag, source_flag_why: flag.why, source_flag_at: new Date().toISOString() } : {}) }).eq('id', l.id);
  }
  const soon = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  const { data: vs } = await db.from('verifications').select('id, document_id, valid_until, documents(cert_body, extracted)').eq('result', 'valid').lte('valid_until', soon).limit(100);
  for (const v of vs ?? []) {
    const d: any = v.documents;
    const r = await runLookup(d.cert_body, { number: d.extracted?.number, holder: d.extracted?.holder });
    if (r.result !== 'not_supported') await db.from('verifications').insert({ document_id: v.document_id, method: 'browser_lookup', checked_where: r.checkedWhere, checked_at: r.checkedAt, result: r.result, valid_until: r.validUntil ?? v.valid_until, notes: 'nightly re-check' });
  }
  return NextResponse.json({
    ok: true, leads: leads?.length ?? 0, certs: vs?.length ?? 0,
    rls: { ok: sweep.ok, summary: sweepSummary(sweep), recorded: sweepNotKept === null, notRecorded: sweepNotKept },
  });
}
