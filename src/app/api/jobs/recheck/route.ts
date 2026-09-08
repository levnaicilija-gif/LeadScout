import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/server';
import { fetchPage } from '@/lib/fetch-page';
import { runLookup } from '@/lib/verify/adapters';
export const maxDuration = 300;
/** Nightly 02:00: (1) re-fetch lead source pages → live/stale/not_found; (2) re-check certs expiring ≤ 90 days. */
export async function POST(req: Request) {
  if (req.headers.get('x-cron-secret') !== process.env.CRON_SECRET) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
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
