/** Read only: has anything a crawl or job writes landed under a workspace other than the one holding the sources? */
import { createClient } from '@supabase/supabase-js';
import { probeAdmin } from '../src/lib/test-data';

const db = probeAdmin();
const TABLES = ['cost_log', 'radar_runs', 'radar_verdicts', 'job_ticks', 'companies', 'leads', 'people', 'job_posts', 'sources', 'contacts'];
(async () => {
  const { data: wss } = await db.from('workspaces').select('id, name');
  for (const w of wss ?? []) {
    const out: string[] = [];
    for (const t of TABLES) {
      const { count, error } = await db.from(t).select('*', { count: 'exact', head: true }).eq('workspace_id', w.id);
      out.push(`${t} ${error ? `n/a (${error.message.slice(0, 40)})` : count}`);
    }
    // Paged: one unpaged read stops at 1,000 rows, and this workspace's spend runs past that.
    const spend: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await db.from('cost_log').select('day, eur').eq('workspace_id', w.id).order('id').range(from, from + 999);
      spend.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const byDay: Record<string, number> = {};
    for (const r of spend ?? []) byDay[r.day] = (byDay[r.day] ?? 0) + Number(r.eur ?? 0);
    console.log(`${w.name}: ${out.join(' · ')}`);
    console.log(`  spend by day: ${Object.entries(byDay).sort().slice(-4).map(([d, e]) => `${d} €${e.toFixed(4)}`).join(', ') || 'none'}`);
  }
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
