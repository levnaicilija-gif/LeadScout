/**
 * What a buyer-aware scoring rule would change, measured before anything touches live scoring.
 *
 *   npx tsx --env-file=.env.local scripts/tender-rule-compare.ts [days]
 *
 * Read-only: no writes, no model call, no browser. Re-run this before changing `ingest.ts`, and
 * again after — a rule nobody re-measured is a rule nobody can defend.
 *
 * THE RULES, all judged with item 12's own `tradeCpvFor` on the PROCEDURE'S MAIN classification,
 * which is the exact test `ingest.ts` applies:
 *   CPV-only              today's rule
 *   CPV-or-buyer          or the contracting authority is in TRADE_BUYERS
 *   CPV-or-(buyer + 45)   ... and the main CPV is construction
 *   CPV-or-(buyer + 45/50) ... construction or repair and maintenance
 *   CPV-and-buyer         both must match
 *
 * TWO HALVES, BECAUSE THE STORED CORPUS CANNOT ANSWER THE MAIN QUESTION. `ingest.ts` returns before
 * storing the article when the CPV misses, so every stored TED award is CPV-passing by construction
 * and the awards a buyer rule would RESCUE were never written down. Half 1 therefore measures only
 * precision — how much of what we already keep a buyer rule would also mark. Half 2, against
 * unfiltered TED, is the one that measures the gain.
 *
 * WHAT IT FOUND (2026-09-20, 6,161 awards over 60 days across DNK/NOR/NLD/BEL/SWE/DEU):
 *   CPV-only 35 · CPV-or-buyer 121 · CPV-or-(buyer+45) 55 · CPV-or-(buyer+45/50) 61 · CPV-and-buyer 4
 * CPV-and-buyer is dead — it would drop 130 of the 136 awards already stored. Unrestricted
 * CPV-or-buyer is too loose: it rescues Energinet's group life insurance (66522000, PFA Pension),
 * its helicopters (60424120, UNI-FLY) and its consultants (71000000, COWI, NIRAS, Norconsult),
 * because a buyer-only rescue takes everything that buyer purchases. The buyer says WHOSE work it
 * is; the CPV still has to say it IS work. 45/50 rather than 45 alone because it is the only variant
 * that rescues the Netherlands at all — Gasunie and TenneT buy under 44xxx, 50xxx and 24xxx — and
 * because it keeps the 50241000/50244000 ship-repair codes that already surface Marinearsenal.
 *
 * Every award a rule would ADD is printed in full, because the totals are not the evidence: the
 * twenty additions were read one by one before the rule was recommended, and that is the step that
 * found the water utilities were mostly sewer trenching and had to be deferred.
 *
 * DEU is capped (PAGE_CAP) and the cap is printed, never hidden; its gain is understated.
 */
import { createClient } from '@supabase/supabase-js';
import { searchTed, AWARD_FIELDS } from '../src/lib/tender/ted';
import { AWARD_NOTICE_TYPES, tradeCpvFor } from '../src/lib/tender/cpv';
import { tradeBuyerFor } from '../src/lib/tender/buyers';
import { probeAdmin } from '../src/lib/test-data';

const admin = probeAdmin();
const DAYS = Number(process.argv[2] ?? 60);
const stamp = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
const TO = stamp(new Date());
const FROM = stamp(new Date(Date.now() - DAYS * 86400000));
const COUNTRIES = ['DNK', 'NOR', 'NLD', 'BEL', 'SWE', 'DEU'];
/** DEU alone runs to five figures; the others are read whole. Any cap is reported, never hidden. */
const PAGE_CAP: Record<string, number> = { DEU: 20 };

const asList = (v: any): string[] => (v == null ? [] : Array.isArray(v) ? v.flatMap(asList) : [String(v)]);
const pick = (v: any): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return pick(v[0]);
  for (const k of ['eng', 'dan', 'nor', 'nld', 'deu', 'swe', 'fra']) if (v[k]) return pick(v[k]);
  const first = Object.values(v)[0];
  return first ? pick(first) : '';
};
const field = (t: string, l: string) => { const m = t.match(new RegExp(`^${l}: (.+)$`, 'm')); return m && !/not stated/i.test(m[1]) ? m[1].trim() : null; };

async function storedHalf() {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await admin.from('articles').select('id,text').ilike('text', '%Contract award notice — TED%').order('id').range(from, from + 999);
    rows.push(...(data ?? [])); if (!data || data.length < 1000) break;
  }
  let cpvOnly = 0, alsoBuyer = 0;
  const matched: string[] = [];
  for (const a of rows) {
    const t = String(a.text);
    const cpv = (field(t, 'Main CPV code') ?? '').split(/[,\s]+/)[0];
    const buyer = (t.match(/^Contracting authority: (.+)$/m) ?? [, ''])[1]?.trim() ?? '';
    const byCpv = !!cpv && tradeCpvFor([cpv]).length > 0;
    const byBuyer = !!tradeBuyerFor(buyer);
    if (byCpv) cpvOnly++;
    if (byCpv && byBuyer) { alsoBuyer++; if (matched.length < 12) matched.push(`${cpv}  ${buyer.slice(0, 48)}`); }
  }
  console.log(`\n================ HALF 1 — the ${rows.length} awards we already store (CPV-passing by construction)`);
  console.log(`  pass CPV-only (today):        ${cpvOnly}`);
  console.log(`  and the buyer is on the list: ${alsoBuyer}  ← what CPV-AND-buyer would keep`);
  console.log(`  so CPV-and-buyer would DROP:  ${cpvOnly - alsoBuyer} of what we have today`);
  if (matched.length) { console.log('  the ones both rules keep:'); matched.forEach((m) => console.log(`    ${m}`)); }
}

async function tedHalf() {
  console.log(`\n================ HALF 2 — unfiltered TED, ${FROM} → ${TO}`);
  const types = AWARD_NOTICE_TYPES.map((t) => `notice-type=${t}`).join(' OR ');
  let tAll = 0, tCpv = 0, tOr = 0, tAnd = 0, tRead = 0, t45 = 0, t4550 = 0;
  const gained: string[] = [];
  for (const iso of COUNTRIES) {
    const query = `(${types}) AND publication-date>=${FROM} AND publication-date<=${TO} AND place-of-performance-country-proc=${iso}`;
    let total = 0, read = 0, cpv = 0, or_ = 0, and_ = 0, or45 = 0, or4550 = 0;
    const cap = PAGE_CAP[iso] ?? 60;
    for (let page = 1; page <= cap; page++) {
      let res;
      try { res = await searchTed({ query, fields: [...AWARD_FIELDS], limit: 100, page }); }
      catch (e: any) { console.log(`  ${iso} page ${page}: ${String(e?.message ?? e).slice(0, 70)}`); break; }
      total = res.totalNoticeCount;
      if (!res.notices.length) break;
      for (const n of res.notices) {
        read++;
        const main = [...new Set(asList(n['main-classification-proc']))];
        const buyer = pick(n['buyer-name']).trim();
        const byCpv = tradeCpvFor(main).length > 0;
        const hit = tradeBuyerFor(buyer);
        // The buyer says WHOSE work it is; the CPV still has to say it IS work. Unrestricted, a
        // buyer rescue takes the insurance (66522000) and the helicopters (60424120) a grid operator
        // also buys, alongside its substations.
        const div = (main[0] ?? "").slice(0, 2);
        if (byCpv) cpv++;
        if (byCpv || hit) or_++;
        if (byCpv && hit) and_++;
        if (byCpv || (hit && div === "45")) or45++;
        if (byCpv || (hit && (div === "45" || div === "50"))) or4550++;
        if (!byCpv && hit && div === "45" && gained.length < 40) {
          gained.push(`${iso} ${main[0] ?? '--------'} ${String(hit.match).padEnd(22)} ${buyer.slice(0, 34)} | ${pick(n['winner-name']).slice(0, 26)}`);
        }
      }
      if (read >= total) break;
    }
    const capped = read < total ? ` (CAPPED — ${read} of ${total} read)` : '';
    console.log(`  ${iso}: ${total} awards${capped}  CPV-only ${cpv}  or-buyer ${or_}  or-buyer+45 ${or45}  or-buyer+45/50 ${or4550}  and-buyer ${and_}`);
    tAll += total; tRead += read; tCpv += cpv; tOr += or_; tAnd += and_; t45 += or45; t4550 += or4550;
  }
  console.log(`\n  TOTAL read ${tRead} of ${tAll}`);
  console.log(`    CPV-only (today):   ${tCpv}`);
  console.log(`    CPV-or-buyer:       ${tOr}   (+${tOr - tCpv}, ${tCpv ? `${(((tOr - tCpv) / tCpv) * 100).toFixed(0)}% more` : 'n/a'})`);
  console.log(`    CPV-and-buyer:      ${tAnd}   (${tCpv - tAnd} fewer than today)`);
  console.log(`    CPV-or-(buyer+45):    ${t45}   (+${t45 - tCpv})  <- construction only`);
  console.log(`    CPV-or-(buyer+45/50): ${t4550}   (+${t4550 - tCpv})  <- construction and repair`);
  if (gained.length) {
    console.log(`\n  EVERY award the TIGHTENED (buyer + CPV 45) rule would ADD — judge these, they are the whole case:`);
    gained.forEach((g) => console.log(`    ${g}`));
  }
}

async function main() {
  await storedHalf();
  await tedHalf();
  console.log('\nRead-only: nothing was written, and ingest.ts is untouched.');
}

main().catch((e) => { console.error(e); process.exit(1); });
