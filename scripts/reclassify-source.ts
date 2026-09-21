/**
 * Re-judge named sources with the real classifier, one row at a time.
 *
 *   npx tsx --env-file=.env.local scripts/reclassify-source.ts offshore.no            # report only
 *   npx tsx --env-file=.env.local scripts/reclassify-source.ts offshore.no --write    # store it
 *
 * Every argument that is not a flag matches a source by URL or name, case-insensitively. A match
 * that hits more than one row is REFUSED rather than guessed at — the fault this exists to repair was
 * one source carrying another's verdict, and a script that silently picked a row would be the same
 * mistake with a different hand on it.
 *
 * WHY THIS EXISTS. api/jobs/classify-sources walks a cursor ("not yet classified", or every row with
 * recheck=1) and cannot be pointed at a single source. On 2026-09-21 offshore.no/jobs was found
 * holding E24's entire verdict — reason, topics, and a relevance of 15 — so it had been switched off
 * on a judgement of a Norwegian news site it has nothing to do with, and there was no way to re-read
 * just that row. It calls `classifySource` (src/lib/source-tier.ts), the SAME function the job route
 * calls, so the two cannot drift.
 *
 * It costs one Haiku read per source and is metered like any other model call (item 16), so a run
 * counts against the daily cap and stops at it.
 */
import { createClient } from '@supabase/supabase-js';
import { classifySource } from '../src/lib/source-tier';
import { Budget } from '../src/lib/cost';
import { crawlWorkspace } from '../src/lib/crawl-workspace';

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const args = process.argv.slice(2);
const write = args.includes('--write');
const needles = args.filter((a) => !a.startsWith('--'));

(async () => {
  if (!needles.length) { console.log('name at least one source (a URL or name fragment)'); process.exit(1); }

  const ws = await crawlWorkspace(admin as any);
  const budget = await Budget.open(admin as any);
  if (budget.exhausted) { console.log(`the daily budget is already spent (€${budget.totalToday.toFixed(4)}) — nothing read`); process.exit(1); }

  const { data: all, error } = await admin.from('sources').select('id, name, url, type, enabled, tier, relevance, topics, tier_reason, classified_at');
  if (error) { console.log(`sources could not be read: ${error.message}`); process.exit(1); }

  let failures = 0;
  for (const needle of needles) {
    const hits = (all ?? []).filter((s: any) => `${s.url ?? ''} ${s.name ?? ''}`.toLowerCase().includes(needle.toLowerCase()));
    if (hits.length !== 1) {
      console.log(`\n"${needle}": ${hits.length === 0 ? 'no source matches' : `${hits.length} sources match — ${hits.map((h: any) => h.url).join(', ')}`}. Refusing to guess.`);
      failures++;
      continue;
    }
    const src: any = hits[0];
    console.log(`\n=== ${src.url}  (type=${src.type})`);
    console.log(`  BEFORE  tier=${src.tier} relevance=${src.relevance} enabled=${src.enabled} classified=${String(src.classified_at ?? 'never').slice(0, 19)}`);
    console.log(`          topics: ${JSON.stringify(src.topics)}`);
    console.log(`          reason: ${src.tier_reason}`);

    if (!budget.canAfford(0.005)) { console.log('  the daily budget would be passed — stopping'); failures++; break; }
    let result;
    try {
      result = await classifySource(admin as any, ws, src, budget);
    } catch (e: any) {
      console.log(`  FAILED to classify: ${String(e?.message ?? e).slice(0, 200)}`);
      failures++;
      continue;
    }
    const { patch, usage, fetched } = result;
    console.log(`  AFTER   tier=${patch.tier} relevance=${patch.relevance} enabled=${patch.enabled}   (page ${fetched ? 'read' : 'COULD NOT be fetched — judged from name and URL alone'})`);
    console.log(`          topics: ${JSON.stringify(patch.topics)}`);
    console.log(`          reason: ${patch.tier_reason}`);
    console.log(`          cost: ${usage.input} in + ${usage.output} out tokens`);

    if (!write) { console.log('  report only — pass --write to store it'); continue; }
    const { error: wrote } = await admin.from('sources').update(patch).eq('id', src.id);
    if (wrote) { console.log(`  NOT STORED: ${wrote.message}`); failures++; continue; }
    const { data: back } = await admin.from('sources').select('tier, relevance, enabled, tier_reason').eq('id', src.id).single();
    console.log(`  stored, and read back: tier=${(back as any)?.tier} relevance=${(back as any)?.relevance} enabled=${(back as any)?.enabled}`);
  }

  console.log(`\nspent today after this run: €${budget.totalToday.toFixed(4)}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
