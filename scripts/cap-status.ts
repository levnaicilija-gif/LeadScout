/**
 * What today's remaining budget actually buys, against what is still outstanding.
 *
 *   npx tsx --env-file=.env.local scripts/cap-status.ts
 *
 * WHY THIS EXISTS RATHER THAN A ONE-LINE SPEND CHECK. A throwaway version of this printed
 * "THE CAP HAS ROOM — batches may run" on the strength of `affordable > 0`, when the room was FOUR lookups
 * against 219 outstanding companies (2026-09-28). Technically true, materially wrong, and it would have
 * justified starting a batch that spends the day's remainder for under 2% of one population. A verdict is
 * only useful next to the size of the job, so this prints both and refuses to reduce them to one word.
 *
 * THE DAY BOUNDARY COMES FROM THE DATABASE, NEVER FROM `new Date()`. The daily cap is keyed on the UTC day,
 * and on 2026-09-27/28 this machine's clock read stale for several exchanges after sleeping — reporting
 * 21:36 through 23:15 UTC while real time was hours ahead, which made "the cap resets in 45 minutes" and
 * "the batches cannot run yet" both false while 75 lookups were affordable the whole time. So the clock here
 * is a row the DATABASE stamps: it is inserted, read back and deleted, costs EUR 0, and cannot be wrong in
 * the way the local clock was. The local clock is printed beside it with the drift, so a repeat is visible
 * rather than silent.
 *
 * READ-ONLY apart from that probe row, which is removed again. It spends nothing and may be run at any time.
 */
import { probeAdmin } from '../src/lib/test-data';
import { spentTodayEur } from '../src/lib/cost';
import { leadSource } from '../src/lib/lead-source';
import { crawlWorkspace } from '../src/lib/crawl-workspace';
import { LEAD_STATE_EMBED, LEAD_STATE_TABLE, CLOSED_LEAD_STATUSES } from '../src/lib/workspace-state';

const db = probeAdmin();
const CAP = 2.0;
/** Measured over two real batches on 2026-09-15 and 2026-09-28: a lookup is a search call plus a haiku resolve. */
const PER_LOOKUP = 0.0213;
/** resolve-domains' own predicate, copied from the route (src/app/api/jobs/resolve-domains/route.ts:31-33). */
const RELEVANT = ['offshore_wind', 'shipyard', 'oil_gas', 'epc', 'industrial', 'marine_contractor', 'om_service'];
const COUNTRIES = ['DK', 'NL', 'NO', 'DE', 'GB', 'BE', 'SE', 'IE', 'FI', 'ES'];

/** The database's own clock, via a row it stamps itself. Removed immediately; costs nothing. */
async function databaseNow(): Promise<string> {
  const p = await db.from('cost_log').insert({ kind: 'fetch', detail: 'cap-status clock probe (no spend)', eur: 0 }).select('id, created_at').single();
  if (p.error) throw new Error(`the database clock could not be read: ${p.error.message}`);
  await db.from('cost_log').delete().eq('id', p.data.id);
  return p.data.created_at as string;
}

(async () => {
  const dbNow = await databaseNow();
  const local = new Date().toISOString();
  const driftSec = Math.abs(Date.parse(local) - Date.parse(dbNow)) / 1000;
  const d = new Date(dbNow);
  const reset = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0));
  const hoursToReset = (+reset - +d) / 3600000;

  const spent = await spentTodayEur(db);
  const room = Math.max(0, CAP - spent);
  const buys = Math.floor(room / PER_LOOKUP);

  console.log(`database clock   ${dbNow}   <-- the authority for the UTC day`);
  console.log(`local clock      ${local}   drift ${driftSec.toFixed(0)}s${driftSec > 120 ? '   *** THE LOCAL CLOCK IS WRONG — trust the database ***' : ''}`);
  console.log(`UTC day          ${dbNow.slice(0, 10)} · cap resets ${reset.toISOString()} (in ${hoursToReset.toFixed(1)}h)`);
  console.log(`spend today      EUR ${spent.toFixed(4)} of ${CAP.toFixed(2)} · room EUR ${room.toFixed(4)}`);
  console.log(`room buys        ${buys} lookup(s) at EUR ${PER_LOOKUP}`);

  // ---- what is OUTSTANDING, because room means nothing without it -------------------------------
  const ws = await crawlWorkspace(db);
  const { data: leads, error } = await db.from('leads')
    .select(`id, source_url, companies!inner(id, name, domain, careers_status, domain_lookups), ${LEAD_STATE_EMBED}`)
    .eq('workspace_id', ws).eq('kind', 'won_work').eq('is_test', false)
    .not(`${LEAD_STATE_TABLE}.status`, 'in', CLOSED_LEAD_STATUSES)
    .is('companies.domain', null).limit(5000) as { data: any[] | null; error: any };
  if (error) throw new Error(`the won-work populations could not be read: ${error.message}`);
  const kinds = new Map<string, Set<string>>();
  const co = new Map<string, any>();
  for (const l of leads ?? []) {
    co.set(l.companies.id, l.companies);
    kinds.set(l.companies.id, (kinds.get(l.companies.id) ?? new Set<string>()).add(leadSource(l.source_url)));
  }
  const payable = (c: any) => c.careers_status !== 'no_domain_found' && Number(c.domain_lookups ?? 0) < 2;
  const news = [...co.entries()].filter(([id]) => kinds.get(id)!.has('news') && !kinds.get(id)!.has('tender')).filter(([, c]) => payable(c)).length;
  const tender = [...co.entries()].filter(([id]) => kinds.get(id)!.has('tender') && !kinds.get(id)!.has('news')).filter(([, c]) => payable(c)).length;

  const ops = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error: e } = await db.from('people').select('company_name').eq('workspace_id', ws).eq('ops_relevant', true).range(from, from + 999);
    if (e) throw new Error(`the ops-relevant contacts could not be read in full: ${e.message}`);
    if (!data?.length) break;
    data.forEach((x: any) => ops.add(String(x.company_name ?? '').trim().toLowerCase()));
    if (data.length < 1000) break;
  }
  const pool: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error: e } = await db.from('companies').select('id, name')
      .eq('workspace_id', ws).in('country', COUNTRIES).in('sector', RELEVANT)
      .is('domain', null).is('careers_checked_at', null)
      .or('careers_status.is.null,careers_status.neq.no_domain_found').lt('domain_lookups', 2)
      .order('id').range(from, from + 999);
    if (e) throw new Error(`the Industry Contacts pool could not be read in full: ${e.message}`);
    if (!data?.length) break;
    pool.push(...data);
    if (data.length < 1000) break;
  }
  const contacts = pool.filter((c) => ops.has(String(c.name ?? '').trim().toLowerCase())).length;

  const outstanding = news + contacts + tender;
  console.log(`\noutstanding      ${outstanding} companies · EUR ${(outstanding * PER_LOOKUP).toFixed(2)} to finish`);
  console.log(`  won-work news  ${String(news).padStart(4)}`);
  console.log(`  ind. contacts  ${String(contacts).padStart(4)}`);
  console.log(`  tender award   ${String(tender).padStart(4)}`);

  // ---- THE VERDICT, always stated against the size of the job -----------------------------------
  // Never "has room" on its own. Four lookups against 219 outstanding is not a batch, and saying so in one
  // word is what made the earlier version misleading.
  const pct = outstanding ? (buys / outstanding) * 100 : 100;
  const days = outstanding && buys > 0 ? Math.ceil((outstanding * PER_LOOKUP) / Math.max(0.01, CAP - 0.25)) : null;
  if (!outstanding) console.log(`\nVERDICT: nothing outstanding — every population is done.`);
  else if (buys <= 0) console.log(`\nVERDICT: CAP SPENT. 0 of ${outstanding} affordable. Resumes at ${reset.toISOString()} (in ${hoursToReset.toFixed(1)}h).`);
  else if (pct < 5) console.log(`\nVERDICT: EFFECTIVELY SPENT — the room buys ${buys} of ${outstanding} outstanding (${pct.toFixed(1)}%). Not worth starting a batch; it spends the day's remainder for almost nothing. Resumes in ${hoursToReset.toFixed(1)}h.`);
  else console.log(`\nVERDICT: room for ${buys} of ${outstanding} outstanding (${pct.toFixed(0)}%)${days ? `, about ${days} day(s) to finish at this cap` : ''}.`);
})().catch((e) => { console.error(`cap-status failed: ${e?.message ?? e}`); process.exitCode = 1; });
