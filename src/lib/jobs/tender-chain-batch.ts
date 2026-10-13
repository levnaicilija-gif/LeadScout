import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/server';
import { cronAuthorised } from '@/lib/jobs/cron-auth';
import { runTenderChain } from './tender-chain';

/**
 * One batch of the tender chain (src/lib/jobs/tender-chain.ts), behind the cron secret — the tick calls it in process.
 *
 *   ?batch=2       companies this batch may look up
 *   ?dry=1         the queue and what it would cost, nothing looked up
 *   ?ids=a,b       named companies only, regardless of the kill switch (the owner's by-hand proof run)
 *
 * The answer is the run summary the tick stores in job_ticks; outcomes are trimmed so a row stays small.
 */
export async function runTenderChainBatch(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const p = new URL(req.url).searchParams;
  const ids = (p.get('ids') ?? '').split(',').map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s)).slice(0, 10);
  try {
    const run = await runTenderChain(supabaseAdmin(), { batch: Math.min(5, Math.max(1, Number(p.get('batch') ?? 2))), write: p.get('dry') !== '1', ids, deadlineAt: Date.now() + 170_000 });
    return NextResponse.json({ ...run, outcomes: run.outcomes.map((o) => ({ name: o.name, result: o.result, domain: o.domain ?? null, address: o.addressCheck ?? null, query: o.query, cvr: !!o.registrationId, eur: Number(o.eur.toFixed(4)) })) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
