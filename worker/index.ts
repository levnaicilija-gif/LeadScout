/** Polls the `jobs` table and runs browser lookups so the web app never waits on a browser. Wire /api/verify to enqueue instead of running inline when JOB_QUEUE=1. */
import { createClient } from '@supabase/supabase-js';
import { runLookup } from '../src/lib/verify/adapters';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function tick() {
  const { data: job } = await db.from('jobs').select('*').eq('status', 'queued').order('created_at').limit(1).maybeSingle();
  if (!job) return;
  await db.from('jobs').update({ status: 'running', attempts: job.attempts + 1 }).eq('id', job.id);
  try {
    if (job.kind === 'lookup') { const r = await runLookup(job.payload.body, job.payload.input); await db.from('verifications').insert({ document_id: job.payload.document_id, method: 'browser_lookup', checked_where: r.checkedWhere, checked_at: r.checkedAt, result: r.result, valid_until: r.validUntil, notes: r.notes }); }
    await db.from('jobs').update({ status: 'done', finished_at: new Date().toISOString() }).eq('id', job.id);
  } catch (e: any) { await db.from('jobs').update({ status: job.attempts >= 2 ? 'failed' : 'queued', error: e.message }).eq('id', job.id); }
}
setInterval(tick, 5000); console.log('worker running');
