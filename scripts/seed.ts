/** npm run seed -- <workspace_id>   Loads seeds/*.csv into sources, people, companies (agencies). */
import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
const ws = process.argv[2]; if (!ws) throw new Error('usage: npm run seed -- <workspace_id>');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const csv = (f: string) => parse(fs.readFileSync(`seeds/${f}`), { columns: true, skip_empty_lines: true }) as any[];
(async () => {
  const src = csv('sources.csv').map((r) => ({ workspace_id: ws, name: r.keywords?.slice(0, 80) || new URL(r.url).hostname, url: r.url.trim(), type: r.type === 'tender' ? 'tender' : r.type === 'job_board' ? 'job_board' : 'news', region: r.regions, paywalled: r.paywalled === 'yes', crawl_prompt: r.prompt || null }));
  for (let i = 0; i < src.length; i += 200) await db.from('sources').upsert(src.slice(i, i + 200), { onConflict: 'workspace_id,url', ignoreDuplicates: true });
  const ppl = csv('people_windeurope.csv').map((r) => ({ workspace_id: ws, company_name: r.company, name: r.name, title: r.title, country: r.country, source: r.source, ops_relevant: r.ops_relevant === 'yes' }));
  for (let i = 0; i < ppl.length; i += 500) await db.from('people').insert(ppl.slice(i, i + 500));
  const ag = csv('agencies.csv').map((r) => ({ workspace_id: ws, name: r.company, domain: (() => { try { return new URL(r.website).hostname; } catch { return null; } })(), employer_type: 'staffing_agency', rfbt_history: r.focus }));
  await db.from('companies').upsert(ag, { onConflict: 'workspace_id,name', ignoreDuplicates: true });
  console.log(`seeded ${src.length} sources, ${ppl.length} people, ${ag.length} agencies`);
})();
