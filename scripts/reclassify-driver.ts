/**
 * Read the 57 too_big companies' careers pages again, on production, one batch at a time, within the daily budget.
 *
 *   npx tsx --env-file=.env.local scripts/reclassify-driver.ts [--not-before 2026-09-15T00:05:00Z]
 *
 * Waits for the time given (the budget resets at 00:00 UTC), then posts batches of the set's still-unread ids with
 * chain=0 and cap=2. Stops when all are read, when the route says the budget is spent, when a batch makes no progress,
 * or when any company outside the set was marked read during the run — the sign that production does not know ids=.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const BASE = 'https://leadscout-rfbt.vercel.app';
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const notBefore = new Date(arg('--not-before') ?? '2026-09-15T00:05:00Z').getTime();
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(0, 19) + 'Z';

(async () => {
  const before: any[] = JSON.parse(readFileSync('.cache/reclassify-before.json', 'utf8'));
  const ids = new Set(before.map((c) => c.id));
  while (Date.now() < notBefore) {
    console.log(`${stamp()} waiting for ${new Date(notBefore).toISOString()}`);
    await wait(Math.min(20 * 60_000, notBefore - Date.now()));
  }
  const started = new Date().toISOString();
  let stalled = 0;
  for (let n = 1; n <= 20; n++) {
    const { data: set, error } = await db.from('companies').select('id, employer_type_checked_at').in('id', [...ids]);
    if (error) throw new Error(error.message);
    const unread = (set ?? []).filter((c: any) => !c.employer_type_checked_at).map((c: any) => c.id);
    if (!unread.length) { console.log(`${stamp()} all ${ids.size} read`); break; }
    const batch = unread.slice(0, 10);
    const res = await fetch(`${BASE}/api/jobs/classify-employers?chain=0&cap=2&batch=${batch.length}&ids=${batch.join(',')}`, {
      method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET! }, signal: AbortSignal.timeout(320_000),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any })).catch((e) => ({ status: 0, body: { error: String(e) } as any }));
    const b = res.body ?? {};
    console.log(`${stamp()} batch ${n}: HTTP ${res.status} · did ${b.did ?? '—'} · ${JSON.stringify(b.counts ?? {})} · unreadable ${b.unreadable ?? '—'} · spent today €${b.spentToday ?? '—'}${b.stopped ? ` · stopped: ${b.stopped}` : ''}${b.error ? ` · error: ${b.error}` : ''}`);

    const { data: outside } = await db.from('companies').select('id, name').gte('employer_type_checked_at', started).limit(200);
    const strays = (outside ?? []).filter((c: any) => !ids.has(c.id));
    if (strays.length) { console.log(`${stamp()} STOP: read outside the set: ${strays.map((c: any) => c.name).join(', ')}`); process.exitCode = 2; break; }
    if (b.stopped) break;
    if (res.status !== 200 || !b.did) { if (++stalled >= 2) { console.log(`${stamp()} STOP: two batches without progress`); process.exitCode = 3; break; } await wait(30_000); } else stalled = 0;
  }
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
