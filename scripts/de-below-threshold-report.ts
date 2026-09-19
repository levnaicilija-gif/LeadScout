/**
 * What Germany's BELOW-THRESHOLD contract awards would add, measured against item 12's own rule.
 *
 *   npx tsx --env-file=.env.local scripts/de-below-threshold-report.ts [from] [to]
 *   npx tsx --env-file=.env.local scripts/de-below-threshold-report.ts 2026-07-21 2026-09-18
 *
 * Report only: it writes nothing, calls no model and opens no browser, so a run costs nothing and
 * never touches the daily cap. Defaults to the 60 days this was first measured over.
 *
 * WHY IT EXISTS. TED (item 12) covers EU/EEA awards above the directive thresholds. Below them each
 * country publishes on its own, and the question was whether that gap is worth ingesting per country
 * the way Doffin exists to fill it for Norway. Germany is the best case available anywhere in EU/EEA:
 * `oeffentlichevergabe.de` serves every federal, state and municipal notice as native eForms over a
 * free, ANONYMOUS API — no registration, no key, no rate limit encountered — where Finland, Norway
 * and the Netherlands each need a key first. So Germany answers the question for all of them: if the
 * yield is thin here it is thinner everywhere else.
 *
 * WHAT IT MEASURED (2026-07-21 → 2026-09-18, 60 days, 0 errors, 0 missing days):
 *   47,790 notices · 17,062 contract award notices
 *   EU-directive 12,459 · below threshold 3,532 · no RegulatoryDomain 1,071
 *   carrying a MAIN classification: below 881 of 3,532 (25%) · EU 12,449 of 12,459 (99.9%)
 *   MAIN classification on item 12's trade list: BELOW 11 · EU 159
 *   → below threshold 0.18/day ≈ 67/year, against ≈967/year Germany already yields through TED.
 *
 * Roughly a 7% uplift, and the eleven were all municipal: six scaffolding jobs on town buildings
 * (Stadt Speyer, Flecken Coppenbrügge, Sprinkenhof), three steel-welding, one heat-power. Below the
 * threshold means small, small means local, and local means town councils rather than the offshore,
 * marine and fabrication work RFBT staffs. Worse, three quarters of below-threshold awards carry no
 * main CPV at all, so they cannot be filtered by the rule item 12 uses; classifying them by their
 * text instead would be ~21,500 notices a year at €0.0077 ≈ €165, about 23% of the €730 annual cap.
 * Owner's decision on this evidence: the below-threshold programme is not worth building.
 *
 * TWO TRAPS IT DELIBERATELY AVOIDS, both found by getting them wrong first.
 *   1. The feed carries two eSender populations — one writes `cbc:`/`cac:` prefixes, the other
 *      generic `ns3:`/`ns5:`. A prefix-bound parser reads ~40% of the corpus as empty and says
 *      nothing: the first pass here reported 5 below-threshold awards on a day that really held 81,
 *      a 16x undercount that looked like a finding. Every tag match below is namespace-agnostic.
 *   2. Item 12 counts a notice only when its PROCEDURE'S MAIN classification is on the list
 *      (`ingest.ts:145` passes `a.mainCpv`) — matching any code made leads of tilers, landscapers and
 *      a lift company on school builds (CLAUDE.md). Only MainCommodityClassification is tested, and
 *      it is tested with `tradeCpvFor` ITSELF rather than a reimplementation, because `covers()` is
 *      hierarchical rather than exact: an exact-equality check against the 42 codes undercounts.
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tradeCpvFor } from '../src/lib/tender/cpv';

const FROM = process.argv[2] ?? '2026-07-21';
const TO = process.argv[3] ?? '2026-09-18';
const ACCEPT = 'application/vnd.bekanntmachungsservice.eforms.zip+zip';
const API = 'https://oeffentlichevergabe.de/api/notice-exports';

/** Namespace-agnostic first value of an element — see trap 1. */
const one = (s: string, tag: string) => {
  const m = s.match(new RegExp(`<(?:[A-Za-z][\\w.-]*:)?${tag}[^>]*>([^<]*)<`));
  return m ? m[1].trim() : null;
};

/**
 * The PROCEDURE's main CPV. MainCommodityClassification appears at procedure and again per lot; the
 * first is the procedure's, which is the one item 12 judges on.
 */
const mainCpv = (s: string) => {
  const block = s.match(/<(?:[A-Za-z][\w.-]*:)?MainCommodityClassification[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?MainCommodityClassification>/);
  if (!block) return null;
  const code = one(block[1], 'ItemClassificationCode');
  return code && /^\d{8}$/.test(code) ? code : null;
};

/** A German national notice names its own regulation; an EU one names the directive. */
const isBelowThreshold = (domain: string) => /^de-/.test(domain);

const days = () => {
  const out: string[] = [];
  for (let d = new Date(`${FROM}T00:00:00Z`); d <= new Date(`${TO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

async function main() {
  const all = { notices: 0, awards: 0, below: 0, eu: 0, unknown: 0, belowMain: 0, euMain: 0, belowTrade: 0, euTrade: 0 };
  const belowHits: string[] = [];
  const euHits: string[] = [];
  const divisions: Record<string, number> = {};
  const list = days();
  console.log(`German notices ${FROM} → ${TO} (${list.length} days) — judged with item 12's own tradeCpvFor on the MAIN classification`);
  console.log('report only: nothing written, no model call, no browser\n');

  for (const day of list) {
    // One day at a time — downloaded, read and deleted — so a 60-day run never holds more than one
    // day's export on disk (a day is about 4 MB zipped, 1,000 notices).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'de-notices-'));
    const zip = path.join(tmp, 'day.zip');
    try {
      execSync(`curl -s -o "${zip}" --max-time 180 -H "Accept: ${ACCEPT}" "${API}?pubDay=${day}"`, { stdio: 'ignore' });
      if (!fs.existsSync(zip) || fs.statSync(zip).size < 200) { console.log(`  ${day}  (nothing served)`); continue; }
      execSync(`unzip -q -o "${zip}" -d "${tmp}/x"`, { stdio: 'ignore' });

      let dayAwards = 0, dayBelow = 0, dayBelowTrade = 0, dayEuTrade = 0;
      for (const f of fs.readdirSync(`${tmp}/x`).filter((n) => n.endsWith('.xml'))) {
        const s = fs.readFileSync(`${tmp}/x/${f}`, 'utf8');
        all.notices++;
        const root = (s.replace(/<\?xml[^>]*\?>/, '').match(/<(?:[A-Za-z][\w.-]*:)?([A-Za-z][\w.-]*)[\s>]/) ?? [, ''])[1];
        if (root !== 'ContractAwardNotice') continue;
        all.awards++; dayAwards++;

        const domain = one(s, 'RegulatoryDomain') ?? '';
        const below = isBelowThreshold(domain);
        // A notice with no RegulatoryDomain is counted and set aside rather than guessed at: on the
        // measured range that is 1,071 of 17,062 awards, and calling them either way would move the
        // headline number by more than the finding itself.
        if (!domain) { all.unknown++; continue; }
        if (below) { all.below++; dayBelow++; } else all.eu++;

        const cpv = mainCpv(s);
        if (!cpv) continue;
        if (below) { all.belowMain++; divisions[cpv.slice(0, 2)] = (divisions[cpv.slice(0, 2)] ?? 0) + 1; } else all.euMain++;

        const hits = tradeCpvFor([cpv]);
        if (!hits.length) continue;
        const who = (one(s, 'Name') ?? '').slice(0, 52);
        if (below) {
          all.belowTrade++; dayBelowTrade++;
          if (belowHits.length < 20) belowHits.push(`${day} ${domain} ${cpv} ${hits[0].sector} | ${who}`);
        } else {
          all.euTrade++; dayEuTrade++;
          if (euHits.length < 6) euHits.push(`${day} ${cpv} ${hits[0].sector} | ${who}`);
        }
      }
      console.log(`  ${day}  awards ${String(dayAwards).padStart(3)}  below ${String(dayBelow).padStart(3)}  trade: below ${dayBelowTrade}, eu ${dayEuTrade}`);
    } catch (e: any) {
      console.log(`  ${day}  ERROR ${String(e?.message ?? e).slice(0, 70)}`);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  const n = list.length;
  const perYear = (x: number) => Math.round((x / n) * 365);
  console.log(`\n================ ${n} DAYS OF GERMAN NOTICES ================`);
  console.log(`notices:                       ${all.notices}`);
  console.log(`contract award notices:        ${all.awards}`);
  console.log(`  EU-directive (reach TED):    ${all.eu}`);
  console.log(`  national / below threshold:  ${all.below}`);
  console.log(`  no RegulatoryDomain:         ${all.unknown}  (counted, never guessed)`);
  console.log(`\nwith a MAIN classification — the only ones item 12's rule can judge:`);
  console.log(`  below threshold:             ${all.belowMain} of ${all.below}`);
  console.log(`  EU:                          ${all.euMain} of ${all.eu}`);
  console.log(`\nMAIN classification on item 12's trade list (tradeCpvFor):`);
  console.log(`  BELOW THRESHOLD:             ${all.belowTrade}   ≈ ${perYear(all.belowTrade)}/year`);
  console.log(`  EU (already ours via TED):   ${all.euTrade}   ≈ ${perYear(all.euTrade)}/year`);
  console.log(`\nbelow-threshold main-CPV divisions: ${Object.entries(divisions).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  if (belowHits.length) { console.log('\nbelow-threshold trade awards found — read WHO these buyers are:'); belowHits.forEach((h) => console.log(`  ${h}`)); }
  if (euHits.length) { console.log('\nEU trade awards (sample, the control):'); euHits.forEach((h) => console.log(`  ${h}`)); }
}

main().catch((e) => { console.error(e); process.exit(1); });
