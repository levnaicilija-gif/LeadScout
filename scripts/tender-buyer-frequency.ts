/**
 * Who to put on the buyer allowlist, derived from frequency in the real data rather than from memory.
 *
 *   npx tsx --env-file=.env.local scripts/tender-buyer-frequency.ts [months]
 *
 * Read-only: no writes, no model call, no browser. This is the first half of maintaining
 * `src/lib/tender/buyers.ts`; `tender-rule-compare.ts` is the second.
 *
 * The blind spot is specific, so the query is too. Item 12's 42 trade codes keep about 1% of award
 * notices in every country, and the work we want sits under the GENERIC PARENT codes a buyer uses
 * when a contract fits no one specialism — 45000000 "Construction work" above all. So this pulls
 * awards whose MAIN classification is one of those, groups them by buyer, and ranks. A buyer that
 * appears once is noise; one that appears repeatedly is a standing customer.
 *
 * IT DOES NOT DECIDE WHO IS AN OPERATOR AND WHO IS A TOWN COUNCIL. That judgement is what the list
 * records, and it is made by reading this output — municipalities recur here too, and they are the
 * control, the thing the list must never contain. Anything added to `buyers.ts` should cite its
 * count from a run of this script, which is why every entry there carries one.
 *
 * WHAT IT FOUND (2026-09-20, 6 months): DNK 461 awards / 214 buyers, NOR 447 / 150, NLD 932 / 385,
 * BEL 762 / 353, SWE 1,453 / 358, DEU 17,918 (4,000 read — the cap is printed). Energinet appears as
 * TWO rows, "Energinet Eltransmission A/S" 24 and "Energinet" 5, which is the concrete reason an
 * allowlist entry is a curated stem rather than a name, and why raw frequency under-counts an
 * operator by splitting its variants. Norway's top buyers are STATSBYGG, Statens vegvesen,
 * Forsvarsbygg and Helse Sør-Øst — state property, roads, defence estates, hospitals — so Norway
 * earns no entries at all, because its offshore work is bought by private operators who never
 * publish to TED.
 */
import { searchTed, AWARD_FIELDS } from '../src/lib/tender/ted';
import { AWARD_NOTICE_TYPES, tradeCpvFor } from '../src/lib/tender/cpv';

const MONTHS = Number(process.argv[2] ?? 6);
/** Where the missed work hides: parents a mixed contract gets filed under. */
const GAP_CODES = ['45000000', '50000000', '71000000', '76000000', '09000000', '31000000', '44000000', '45200000', '45300000', '45500000'];
/** The North Sea and Baltic markets RFBT staffs, plus the two biggest by volume. */
const COUNTRIES = ['DNK', 'NOR', 'NLD', 'BEL', 'SWE', 'DEU'];

const stamp = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
const TO = stamp(new Date());
const FROM = stamp(new Date(Date.now() - MONTHS * 30 * 86400000));

const asList = (v: any): string[] => (v == null ? [] : Array.isArray(v) ? v.flatMap(asList) : [String(v)]);
const pick = (v: any): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return pick(v[0]);
  for (const k of ['eng', 'dan', 'nor', 'nld', 'deu', 'swe', 'fra']) if (v[k]) return pick(v[k]);
  const first = Object.values(v)[0];
  return first ? pick(first) : '';
};

type Buyer = { name: string; awards: number; kept: number; cpv: Record<string, number>; winners: Set<string>; titles: string[] };

async function forCountry(iso: string) {
  const types = AWARD_NOTICE_TYPES.map((t) => `notice-type=${t}`).join(' OR ');
  const codes = GAP_CODES.map((c) => `main-classification-proc=${c}`).join(' OR ');
  const query = `(${types}) AND (${codes}) AND publication-date>=${FROM} AND publication-date<=${TO} AND place-of-performance-country-proc=${iso}`;
  const buyers = new Map<string, Buyer>();
  let total = 0, read = 0;
  for (let page = 1; page <= 40; page++) {
    let res;
    try { res = await searchTed({ query, fields: [...AWARD_FIELDS], limit: 100, page }); }
    catch (e: any) { console.log(`  ${iso} page ${page}: ${String(e?.message ?? e).slice(0, 80)}`); break; }
    total = res.totalNoticeCount;
    if (!res.notices.length) break;
    for (const n of res.notices) {
      read++;
      const name = pick(n['buyer-name']).trim();
      if (!name) continue;
      const main = [...new Set(asList(n['main-classification-proc']))];
      const b = buyers.get(name) ?? { name, awards: 0, kept: 0, cpv: {}, winners: new Set<string>(), titles: [] };
      b.awards++;
      if (tradeCpvFor(main).length) b.kept++;
      for (const c of main) b.cpv[c] = (b.cpv[c] ?? 0) + 1;
      const w = pick(n['winner-name']).trim();
      if (w) b.winners.add(w);
      if (b.titles.length < 2) b.titles.push(pick(n['notice-title']).slice(0, 70));
      buyers.set(name, b);
    }
    if (read >= total) break;
  }
  return { iso, total, read, buyers: [...buyers.values()].sort((a, b) => b.awards - a.awards) };
}

async function main() {
  console.log(`TED awards under the GENERIC codes we currently drop — ${FROM} → ${TO} (${MONTHS} months)`);
  console.log(`codes: ${GAP_CODES.join(', ')}\n`);
  for (const iso of COUNTRIES) {
    const r = await forCountry(iso);
    console.log(`\n================ ${r.iso} — ${r.total} awards under these codes (read ${r.read}), ${r.buyers.length} distinct buyers`);
    const repeat = r.buyers.filter((b) => b.awards >= 2);
    console.log(`buyers appearing twice or more: ${repeat.length}\n`);
    for (const b of repeat.slice(0, 30)) {
      const top = Object.entries(b.cpv).sort((a, c) => c[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}×${v}`).join(' ');
      console.log(`  ${String(b.awards).padStart(3)} awards (${b.kept} kept today)  ${b.name.slice(0, 50)}`);
      console.log(`        cpv ${top}`);
      console.log(`        e.g. ${b.titles[0] ?? ''}`);
    }
  }
  console.log('\nRead this for operators that recur: a grid company, a port, a utility, an energy group.');
  console.log('Municipalities recur too and are the control — they are what the list must NOT contain.');
}

main().catch((e) => { console.error(e); process.exit(1); });
