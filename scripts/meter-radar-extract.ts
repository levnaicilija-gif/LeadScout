/**
 * What Radar's extraction actually costs, measured — and what the unmetered days really spent.
 *
 *   npx tsx --env-file=.env.local scripts/meter-radar-extract.ts [--sample 24]
 *
 * Until 2026-09-13 Radar's Stage 1 call (extractLead) and its job-post pass (extractJobPost) went
 * through askJson, which logged nothing, so cost_log never held them and the €2 cap never saw them.
 * This runs both on a sample of articles Radar already stored, counts every attempt's tokens
 * (askJson retries once on a malformed answer), logs that real spend to cost_log, and multiplies
 * the measured mean by how many calls each past day made — the number of articles it stored.
 *
 * Writes no leads, contacts or companies. The sample itself is real model spend, and is logged.
 */
import { createClient } from '@supabase/supabase-js';
import { extractLead, extractJobPost } from '../src/lib/ai/radar-extract';
import { MODEL_EXTRACT } from '../src/lib/ai/claude';
import { modelCostEur, logModelCall } from '../src/lib/cost';
import { probeAdmin } from '../src/lib/test-data';

const db = probeAdmin();
const N = Number(process.argv[process.argv.indexOf('--sample') + 1]) || 24;

async function all<T>(q: (from: number) => PromiseLike<{ data: T[] | null; error: any }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) return rows;
  }
}

(async () => {
  const { data: ted } = await db.from('sources').select('workspace_id').eq('url', 'https://ted.europa.eu/').maybeSingle();
  const ws = ted?.workspace_id as string;
  const articles = await all<any>((f) => db.from('articles').select('id, url, text, fetched_at, sources(type)').not('url', 'ilike', 'https://ted.europa.eu/%').range(f, f + 999));

  // An even spread over the stored set, so long and short pages and every day are in the sample.
  const sorted = [...articles].sort((a, b) => (a.text ?? '').length - (b.text ?? '').length);
  const sample = Array.from({ length: Math.min(N, sorted.length) }, (_, i) => sorted[Math.floor((i + 0.5) * sorted.length / Math.min(N, sorted.length))]);
  const jobSample = articles.filter((a) => ['job_board', 'company_press'].includes(a.sources?.type)).slice(0, 6);

  const meter = { calls: 0, attempts: 0, inTok: 0, outTok: 0, eur: 0 };
  const jobMeter = { calls: 0, attempts: 0, inTok: 0, outTok: 0, eur: 0 };
  const onUsageFor = (m: typeof meter, detail: string) => async (usage: any, model: string) => {
    m.attempts++;
    m.inTok += usage?.input_tokens ?? 0;
    m.outTok += usage?.output_tokens ?? 0;
    m.eur += modelCostEur(model, usage?.input_tokens ?? 0, usage?.output_tokens ?? 0);
    await logModelCall(db, ws, model, `metering sample · ${detail}`, usage);
  };

  for (const a of sample) {
    meter.calls++;
    try { await extractLead(a.text ?? '', a.url, { onUsage: onUsageFor(meter, `radar stage1 ${new URL(a.url).hostname}`) }); }
    catch (e: any) { console.log(`  stage1 threw on ${a.url}: ${String(e?.message ?? e).slice(0, 100)}`); }
  }
  for (const a of jobSample) {
    jobMeter.calls++;
    try { await extractJobPost(a.text ?? '', a.url, { onUsage: onUsageFor(jobMeter, `radar job post ${new URL(a.url).hostname}`) }); }
    catch (e: any) { console.log(`  job post threw on ${a.url}: ${String(e?.message ?? e).slice(0, 100)}`); }
  }

  const per = (m: typeof meter) => (m.calls ? m.eur / m.calls : 0);
  console.log(`\nStage 1 (${MODEL_EXTRACT}): ${meter.calls} articles, ${meter.attempts} attempts, ${meter.inTok}+${meter.outTok} tokens, €${meter.eur.toFixed(4)} → €${per(meter).toFixed(5)} per article`);
  console.log(`Job-post pass: ${jobMeter.calls} pages, ${jobMeter.attempts} attempts, ${jobMeter.inTok}+${jobMeter.outTok} tokens, €${jobMeter.eur.toFixed(4)} → €${per(jobMeter).toFixed(5)} per page`);
  console.log(`sample spend logged to cost_log: €${(meter.eur + jobMeter.eur).toFixed(4)}\n`);

  // Past days: every stored news article was one Stage 1 call; a job_board/company_press article one more.
  const days: Record<string, { stage1: number; job: number }> = {};
  for (const a of articles) {
    const d = String(a.fetched_at).slice(0, 10);
    days[d] ??= { stage1: 0, job: 0 };
    days[d].stage1++;
    if (['job_board', 'company_press'].includes(a.sources?.type)) days[d].job++;
  }
  const logged = await all<any>((f) => db.from('cost_log').select('day, eur, detail').range(f, f + 999));
  console.log('day          Stage 1 calls  job-post calls  unmetered (est.)  logged in cost_log  total');
  for (const d of Object.keys(days).sort()) {
    const est = days[d].stage1 * per(meter) + days[d].job * per(jobMeter);
    const log = logged.filter((r) => r.day === d && !/metering sample/.test(r.detail ?? '')).reduce((s, r) => s + Number(r.eur ?? 0), 0);
    console.log(`${d}   ${String(days[d].stage1).padStart(12)}  ${String(days[d].job).padStart(14)}  €${est.toFixed(2).padStart(15)}  €${log.toFixed(2).padStart(17)}  €${(est + log).toFixed(2)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
