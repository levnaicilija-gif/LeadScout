/**
 * Run the TED award pass from a terminal: a backfill, a dry run, or specific notices.
 *
 *   npx tsx --env-file=.env.local scripts/run-tenders.ts --from 2026-09-06 --to 2026-09-13
 *   npx tsx --env-file=.env.local scripts/run-tenders.ts --from 2026-08-14 --to 2026-09-13 --dry-run
 *   npx tsx --env-file=.env.local scripts/run-tenders.ts --notices 196411-2026 --dry-run --ignore-cpv
 *
 * Writes to the real workspace unless --dry-run. Prints the report the route returns, with the
 * per-lead lines and rejections in full.
 */
import { createClient } from '@supabase/supabase-js';
import { ingestTedAwards, tedWindowFor } from '../src/lib/tender/ingest';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const flag = (name: string) => process.argv.includes(`--${name}`);

(async () => {
  const auto = await tedWindowFor(db);
  const report = await ingestTedAwards(db, {
    from: arg('from') ?? auto.from,
    to: arg('to') ?? auto.to,
    deadlineAt: Date.now() + Number(arg('minutes') ?? 60) * 60_000,
    dryRun: flag('dry-run'),
    notices: arg('notices')?.split(',').map((s) => s.trim()).filter(Boolean),
    ignoreCpv: flag('ignore-cpv'),
  });
  const { leads, rejected, merged, ...tally } = report;
  console.log(JSON.stringify(tally, null, 2));
  console.log(`\nleads (${leads.length}):`);
  for (const l of leads) console.log(`  ${l.notice}  ${l.companyCreated ? 'NEW ' : 'SAME'}  ${l.company}${l.matchedOn ? `  [${l.matchedOn}]` : ''}  · ${l.country ?? 'country not stated'} · ${l.value ?? 'value not stated'}${l.mergedInto ? `  → linked to lead ${l.mergedInto}` : ''}`);
  console.log(`\nsame contract as an existing lead (${merged.length}):`);
  for (const m of merged) console.log(`  ${m.notice}  ${m.company} → lead ${m.leadId}  [canonical: ${m.canonical}]\n      ${m.why}`);
  const reasons = new Map<string, number>();
  for (const r of rejected) { const k = r.why.replace(/\(.*\)$/, '').trim(); reasons.set(k, (reasons.get(k) ?? 0) + 1); }
  console.log('\nnot made into leads, by reason:');
  for (const [why, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${why}`);
})().catch((e) => { console.error(e); process.exit(1); });
