/** Read only: has anything a crawl or job writes landed under a workspace other than the one holding the sources? */
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const TABLES = ['cost_log', 'radar_runs', 'radar_verdicts', 'job_ticks', 'companies', 'leads', 'people', 'job_posts', 'sources', 'contacts'];
(async () => {
  const { data: wss } = await db.from('workspaces').select('id, name');
  for (const w of wss ?? []) {
    const out: string[] = [];
    for (const t of TABLES) {
      const { count, error } = await db.from(t).select('*', { count: 'exact', head: true }).eq('workspace_id', w.id);
      out.push(`${t} ${error ? `n/a (${error.message.slice(0, 40)})` : count}`);
    }
    const { data: spend } = await db.from('cost_log').select('day, eur').eq('workspace_id', w.id);
    const byDay: Record<string, number> = {};
    for (const r of spend ?? []) byDay[r.day] = (byDay[r.day] ?? 0) + Number(r.eur ?? 0);
    console.log(`${w.name}: ${out.join(' · ')}`);
    console.log(`  spend by day: ${Object.entries(byDay).sort().slice(-4).map(([d, e]) => `${d} €${e.toFixed(4)}`).join(', ') || 'none'}`);
  }
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
