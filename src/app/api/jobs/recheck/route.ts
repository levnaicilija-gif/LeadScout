import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/server';
import { fetchPage } from '@/lib/fetch-page';
import { runLookup } from '@/lib/verify/adapters';
export const maxDuration = 300;
/**
 * Nightly: (1) re-fetch lead source pages → live/stale/not_found; (2) re-check certs expiring
 * ≤ 90 days; (3) start the careers work.
 *
 * Careers discovery and the job-post crawl ride this cron rather than taking cron slots of their
 * own — the plan allows two, and both are already spoken for. They are dispatched first and
 * abandoned on purpose: each chains itself onward, and waiting would nest three 300 s budgets.
 */
export const GET = (req: Request) => POST(req);

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const authorised = !!secret && (req.headers.get('x-cron-secret') === secret || req.headers.get('authorization') === `Bearer ${secret}`);
  if (!authorised) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();

  const origin = new URL(req.url).origin;
  const kick = async (path: string) => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    await fetch(`${origin}${path}`, { method: 'POST', headers: { 'x-cron-secret': secret! }, signal: ac.signal }).catch(() => {});
  };
  await kick('/api/jobs/careers-discovery?batch=25&batchesLeft=30');
  await kick('/api/jobs/job-posts?batch=10&batchesLeft=30');
  const { data: leads } = await db.from('leads').select('id, source_url, kind, created_at').not('status', 'in', '("stale","not_for_us")').limit(200);
  for (const l of leads ?? []) {
    if (!l.source_url) continue;
    const p = await fetchPage(l.source_url);
    const ageDays = (Date.now() - new Date(l.created_at).getTime()) / 86400000;
    const status = p.status === 'not_found' ? 'not_found' : ageDays > 30 && l.kind === 'job_post' ? 'stale' : 'live';
    await db.from('leads').update({ source_fetch_status: status, source_fetched_at: p.fetchedAt, ...(status === 'not_found' ? { status: 'stale' } : {}) }).eq('id', l.id);
  }
  const soon = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  const { data: vs } = await db.from('verifications').select('id, document_id, valid_until, documents(cert_body, extracted)').eq('result', 'valid').lte('valid_until', soon).limit(100);
  for (const v of vs ?? []) {
    const d: any = v.documents;
    const r = await runLookup(d.cert_body, { number: d.extracted?.number, holder: d.extracted?.holder });
    if (r.result !== 'not_supported') await db.from('verifications').insert({ document_id: v.document_id, method: 'browser_lookup', checked_where: r.checkedWhere, checked_at: r.checkedAt, result: r.result, valid_until: r.validUntil ?? v.valid_until, notes: 'nightly re-check' });
  }
  return NextResponse.json({ ok: true, leads: leads?.length ?? 0, certs: vs?.length ?? 0 });
}
