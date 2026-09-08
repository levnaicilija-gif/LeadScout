/**
 * npm run seed -- <workspace_id> [--force-people]
 * Loads seeds/*.csv into sources, people and companies (agencies).
 * Safe to re-run: sources and companies upsert on their unique keys, and people are skipped
 * when the workspace already has them (they have no natural key, so a second plain insert
 * would duplicate all 12,582 rows). --force-people replaces them.
 */
import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse/sync';
import fs from 'fs';

const ws = process.argv[2];
if (!ws) throw new Error('usage: npm run seed -- <workspace_id> [--force-people]');
const forcePeople = process.argv.includes('--force-people');

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const csv = (f: string) => parse(fs.readFileSync(`seeds/${f}`), { columns: true, skip_empty_lines: true }) as any[];
/** Never let a write fail quietly — a half-seeded workspace looks like a working one. */
const check = (label: string, { error }: { error: unknown }) => {
  if (error) throw new Error(`${label}: ${(error as any).code ?? ''} ${(error as any).message ?? error}`);
};

(async () => {
  // name is the hostname. `keywords` is not a name — it is empty on half the rows and free
  // prose on a few, which put paragraphs in the Sources list. Keywords belong with the
  // crawl prompt, which is what Radar actually reads.
  const hostname = (u: string) => new URL(u.trim()).hostname.replace(/^www\./, '');
  const src = csv('sources.csv').map((r) => ({
    workspace_id: ws,
    name: hostname(r.url),
    url: r.url.trim(),
    type: r.type === 'tender' ? 'tender' : r.type === 'job_board' ? 'job_board' : 'news',
    region: r.regions,
    paywalled: r.paywalled === 'yes',
    crawl_prompt: [r.prompt, r.keywords && `Keywords: ${r.keywords}`].filter(Boolean).join('\n\n') || null,
  }));
  for (let i = 0; i < src.length; i += 200) {
    check('sources', await db.from('sources').upsert(src.slice(i, i + 200), { onConflict: 'workspace_id,url' }));
  }

  const { count: havePeople } = await db.from('people').select('id', { count: 'exact', head: true }).eq('workspace_id', ws);
  let peopleLoaded = 0;
  if (havePeople && !forcePeople) {
    console.log(`people: ${havePeople} already in this workspace — skipping (pass --force-people to replace)`);
  } else {
    if (forcePeople) check('people delete', await db.from('people').delete().eq('workspace_id', ws));
    const ppl = csv('people_windeurope.csv').map((r) => ({
      workspace_id: ws, company_name: r.company, name: r.name, title: r.title,
      country: r.country, source: r.source, ops_relevant: r.ops_relevant === 'yes',
    }));
    for (let i = 0; i < ppl.length; i += 500) check('people', await db.from('people').insert(ppl.slice(i, i + 500)));
    peopleLoaded = ppl.length;
  }

  const ag = csv('agencies.csv').map((r) => ({
    workspace_id: ws, name: r.company,
    domain: (() => { try { return new URL(r.website).hostname; } catch { return null; } })(),
    employer_type: 'staffing_agency', rfbt_history: r.focus,
  }));
  check('companies', await db.from('companies').upsert(ag, { onConflict: 'workspace_id,name' }));

  const { count: sources } = await db.from('sources').select('id', { count: 'exact', head: true }).eq('workspace_id', ws);
  const { count: people } = await db.from('people').select('id', { count: 'exact', head: true }).eq('workspace_id', ws);
  const { count: companies } = await db.from('companies').select('id', { count: 'exact', head: true }).eq('workspace_id', ws);
  console.log(`seeded from csv: ${src.length} sources, ${peopleLoaded} people, ${ag.length} agencies`);
  console.log(`workspace now holds: ${sources} sources, ${people} people, ${companies} companies`);
})();
