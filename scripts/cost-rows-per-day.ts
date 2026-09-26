/** Read only: cost_log rows and euros per day across all workspaces, counted exactly (not capped at 1,000 rows). */
import { createClient } from '@supabase/supabase-js';
import { probeAdmin } from '../src/lib/test-data';

const db = probeAdmin();
(async () => {
  const byDay: Record<string, { rows: number; eur: number }> = {};
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('cost_log').select('day, eur').order('id').range(f, f + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) { const d = (byDay[r.day] ??= { rows: 0, eur: 0 }); d.rows++; d.eur += Number(r.eur ?? 0); }
    if (!data || data.length < 1000) break;
  }
  for (const [d, v] of Object.entries(byDay).sort()) console.log(`${d} · rows ${v.rows} · €${v.eur.toFixed(4)}`);
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
