/**
 * WHO is buying the German trade work item 12 already brings in — municipal building, or the
 * offshore, marine and industrial EPC RFBT actually staffs?
 *
 *   npx tsx --env-file=.env.local scripts/de-buyer-mix-report.ts [from] [to]
 *
 * Report only: writes nothing, calls no model, opens no browser. Same window, same source and same
 * rule as `de-below-threshold-report.ts` — every award whose PROCEDURE'S MAIN classification is on
 * item 12's list per `tradeCpvFor`, the exact test the TED ingest applies (ingest.ts:145).
 *
 * WHY. The below-threshold measurement answered its own question and raised a sharper one: its
 * EU-threshold control sample looked municipal too. If that holds, item 12's German yield is feeding
 * Radar school refurbishments rather than offshore work, and the problem is not the threshold — it is
 * the country, or the trade codes.
 *
 * THE BUYER IS READ FROM CODED FIELDS, NOT FROM ITS NAME, and that correction is the point of this
 * file. The first version guessed the buyer's kind from a name regex and took the buyer to be the
 * first `Name` in the document. Both were wrong, and wrong in a way that read as a finding:
 * `cac:ContractingParty` carries only an ID reference (`ORG-0001`) and no name at all, so the
 * fallback returned whichever organisation the sender happened to list first — frequently the WINNER.
 * A third of the sample came back as scaffolding and steel firms — Gerüstbau Stuiber, Lehner
 * Gerüsttechnik, Kattner Stahlbau, Tiefbau Gotha — companies that win scaffolding and steelwork, and
 * two of which are already award leads of ours. Any "45% municipal" figure taken off that mix was
 * measuring nothing.
 *
 * eForms answers this properly and in its own vocabulary, so nothing here is inferred from wording:
 *   `authority-activity`  the buyer's own sector — gen-pub, health, education, rail, water, defence,
 *                         and, where they occur, the utilities activities that would mark an offshore
 *                         or energy buyer: port, airport, gas-oil, electricity.
 *   `buyer-legal-type`    German eForms extension codes, which separate municipal from state from
 *                         federal exactly: kommun-beh, koerp-oer-kommun and anst-oer-kommun are
 *                         municipal; omu-lbeh, koerp-oer-land and anst-oer-land are Land; -bund is
 *                         federal; pub-undert is a public undertaking.
 * The buyer's NAME is resolved properly for the printed list — ContractingParty's ORG id looked up in
 * the `efac:Organization` block carrying that id — and is used for display only, never to classify.
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

const one = (s: string, tag: string) => {
  const m = s.match(new RegExp(`<(?:[A-Za-z][\\w.-]*:)?${tag}[^>]*>([^<]*)<`));
  return m ? m[1].trim() : null;
};
const coded = (s: string, listName: string) => {
  const m = s.match(new RegExp(`listName="${listName}"[^>]*>([^<]*)<`));
  return m ? m[1].trim() : null;
};

const mainCpv = (s: string) => {
  const block = s.match(/<(?:[A-Za-z][\w.-]*:)?MainCommodityClassification[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?MainCommodityClassification>/);
  if (!block) return null;
  const code = one(block[1], 'ItemClassificationCode');
  return code && /^\d{8}$/.test(code) ? code : null;
};

/** The buyer's name, resolved through its ORG id. Display only — classification uses the codes. */
const buyerName = (s: string) => {
  const cp = s.match(/<(?:[A-Za-z][\w.-]*:)?ContractingParty[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?ContractingParty>/);
  const id = cp ? (cp[1].match(/<(?:[A-Za-z][\w.-]*:)?ID[^>]*>(ORG-\d+)</) ?? [, null])[1] : null;
  if (id) {
    for (const blk of s.split(/<(?:[A-Za-z][\w.-]*:)?Organization>/).slice(1)) {
      if (!new RegExp(`<(?:[A-Za-z][\\w.-]*:)?ID[^>]*>${id}<`).test(blk)) continue;
      const pn = blk.match(/<(?:[A-Za-z][\w.-]*:)?PartyName[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?PartyName>/);
      const nm = pn ? one(pn[1], 'Name') : null;
      if (nm) return nm;
    }
  }
  return '(buyer not resolvable)';
};

/** Activities that would mark a buyer in RFBT's world rather than a town council. */
const RFBT_ACTIVITY = new Set(['port', 'airport', 'gas-oil', 'electricity', 'water', 'rail', 'urttb', 'post', 'gas-heat', 'coal']);
const MUNICIPAL_LEGAL = /kommun/i;

const days = () => {
  const out: string[] = [];
  for (let d = new Date(`${FROM}T00:00:00Z`); d <= new Date(`${TO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
};

async function main() {
  const list = days();
  type Hit = { day: string; cpv: string; sector: string; buyer: string; activity: string; legal: string; below: boolean };
  const hits: Hit[] = [];
  console.log(`German trade-matched awards ${FROM} → ${TO} (${list.length} days), buyer read from eForms coded fields\n`);

  for (const day of list) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'de-buyer-'));
    const zip = path.join(tmp, 'day.zip');
    try {
      execSync(`curl -s -o "${zip}" --max-time 180 -H "Accept: ${ACCEPT}" "${API}?pubDay=${day}"`, { stdio: 'ignore' });
      if (!fs.existsSync(zip) || fs.statSync(zip).size < 200) continue;
      execSync(`unzip -q -o "${zip}" -d "${tmp}/x"`, { stdio: 'ignore' });
      let found = 0;
      for (const f of fs.readdirSync(`${tmp}/x`).filter((n) => n.endsWith('.xml'))) {
        const s = fs.readFileSync(`${tmp}/x/${f}`, 'utf8');
        const root = (s.replace(/<\?xml[^>]*\?>/, '').match(/<(?:[A-Za-z][\w.-]*:)?([A-Za-z][\w.-]*)[\s>]/) ?? [, ''])[1];
        if (root !== 'ContractAwardNotice') continue;
        const domain = one(s, 'RegulatoryDomain') ?? '';
        if (!domain) continue;
        const cpv = mainCpv(s);
        if (!cpv) continue;
        const t = tradeCpvFor([cpv]);
        if (!t.length) continue;
        hits.push({
          day, cpv, sector: t[0].sector, buyer: buyerName(s),
          activity: coded(s, 'authority-activity') ?? '(none)',
          legal: coded(s, 'buyer-legal-type') ?? '(none)',
          below: /^de-/.test(domain),
        });
        found++;
      }
      if (found) console.log(`  ${day}  ${found} trade award(s)`);
    } catch (e: any) {
      console.log(`  ${day}  ERROR ${String(e?.message ?? e).slice(0, 70)}`);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  const eu = hits.filter((h) => !h.below);
  console.log(`\n================ ${hits.length} TRADE-MATCHED AWARDS (${eu.length} EU, ${hits.length - eu.length} below threshold) ================`);

  const tally = (key: 'activity' | 'legal') => {
    const o: Record<string, number> = {};
    eu.forEach((h) => { o[h[key]] = (o[h[key]] ?? 0) + 1; });
    return Object.entries(o).sort((a, b) => b[1] - a[1]);
  };
  const pct = (n: number) => `${((n / Math.max(eu.length, 1)) * 100).toFixed(0)}%`;

  console.log('\nbuyer sector (eForms authority-activity):');
  for (const [k, v] of tally('activity')) console.log(`  ${String(v).padStart(3)} (${pct(v).padStart(3)})  ${k}`);
  console.log('\nbuyer legal type (German eForms buyer-legal-type):');
  for (const [k, v] of tally('legal')) console.log(`  ${String(v).padStart(3)} (${pct(v).padStart(3)})  ${k}`);

  const rfbt = eu.filter((h) => RFBT_ACTIVITY.has(h.activity));
  const municipal = eu.filter((h) => MUNICIPAL_LEGAL.test(h.legal));
  const unresolved = eu.filter((h) => h.activity === '(none)' && h.legal === '(none)');
  console.log(`\nbuyers whose own activity code puts them in RFBT's world: ${rfbt.length} of ${eu.length} (${pct(rfbt.length)})`);
  console.log(`buyers whose legal type is explicitly municipal:          ${municipal.length} of ${eu.length} (${pct(municipal.length)})`);
  console.log(`neither code present — cannot be judged either way:       ${unresolved.length} of ${eu.length} (${pct(unresolved.length)})`);

  const sectors: Record<string, number> = {};
  eu.forEach((h) => { sectors[h.sector] = (sectors[h.sector] ?? 0) + 1; });
  console.log(`\nby item 12 sector: ${Object.entries(sectors).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ')}`);

  if (rfbt.length) {
    console.log('\nthe RFBT-world awards in full:');
    for (const h of rfbt) console.log(`  ${h.day} ${h.cpv} ${h.sector.padEnd(13)} ${h.activity.padEnd(11)} ${h.buyer.slice(0, 52)}`);
  }
  console.log('\nevery EU trade award, for the owner to overrule the codes:');
  for (const h of eu) console.log(`  ${h.day} ${h.cpv} ${h.sector.padEnd(13)} ${h.activity.padEnd(11)} ${h.legal.padEnd(18)} ${h.buyer.slice(0, 46)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
