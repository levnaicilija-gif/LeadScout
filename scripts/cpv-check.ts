/**
 * Proves the trade CPV list against the official vocabulary, and optionally against TED.
 *
 *   npx tsx --env-file=.env.local scripts/cpv-check.ts            # codes and labels
 *   npx tsx --env-file=.env.local scripts/cpv-check.ts --volume   # plus 30 days of TED awards per code
 *
 * The vocabulary is the one the EU Publications Office ships with the eForms SDK — the same
 * codelist TED validates notices against — so a code that passes here is a code TED knows. Exits
 * 1 on any missing code or label that differs, so a hand-edited entry cannot drift quietly.
 */
import { TRADE_CPV, AWARD_NOTICE_TYPES, tradeCpvFor } from '../src/lib/tender/cpv';
import { searchTed } from '../src/lib/tender/ted';

const CODELIST = 'https://raw.githubusercontent.com/OP-TED/eForms-SDK/develop/codelists/cpv.gc';

(async () => {
  const res = await fetch(CODELIST);
  if (!res.ok) { console.error(`could not download the CPV codelist: HTTP ${res.status}`); process.exit(1); }
  const xml = await res.text();
  const official = new Map<string, string>();
  for (const row of xml.split('<Row>').slice(1)) {
    const code = row.match(/ColumnRef="code">\s*<SimpleValue>([^<]*)</)?.[1];
    const label = row.match(/ColumnRef="eng_label">\s*<SimpleValue>([^<]*)</)?.[1];
    if (code && label) official.set(code, label);
  }
  console.log(`official CPV 2008 vocabulary: ${official.size} codes\n`);
  if (official.size < 9000) { console.error('the codelist looks truncated — refusing to call anything valid'); process.exit(1); }

  let bad = 0;
  for (const e of TRADE_CPV) {
    const label = official.get(e.code);
    const ok = label === e.label;
    if (!ok) bad++;
    console.log(`${ok ? '  OK  ' : '  BAD '} ${e.code}  ${e.label}${ok ? '' : `  — official: ${label ?? 'no such code'}`}`);
  }
  console.log(`\n${TRADE_CPV.length} codes, ${bad} wrong`);

  if (process.argv.includes('--volume')) {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 86400000);
    const d = (x: Date) => x.toISOString().slice(0, 10).replace(/-/g, '');
    const window = `publication-date>=${d(from)} AND publication-date<=${d(to)}`;
    const types = `notice-type IN (${AWARD_NOTICE_TYPES.join(' ')})`;
    console.log(`\naward notices on TED, ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}:`);
    for (const e of TRADE_CPV) {
      const r = await searchTed({ query: `${types} AND ${window} AND classification-cpv IN (${e.code})`, fields: ['publication-number'], limit: 1, page: 1 });
      console.log(`  ${String(r.totalNoticeCount).padStart(5)}  ${e.code}  ${e.label}`);
    }
    // TED matches a code anywhere on the notice; the pass keeps only notices whose procedure's
    // main classification is on the list. Count both, so the difference is visible.
    const query = `${types} AND ${window} AND classification-cpv IN (${TRADE_CPV.map((e) => e.code).join(' ')})`;
    let total = 0, mainHits = 0, winners = 0;
    for (let page = 1; ; page++) {
      const r = await searchTed({ query, fields: ['publication-number', 'main-classification-proc', 'winner-name'], limit: 100, page });
      total = r.totalNoticeCount;
      for (const n of r.notices) {
        if (!tradeCpvFor(([] as string[]).concat(n['main-classification-proc'] ?? [])).length) continue;
        mainHits++;
        if (n['winner-name'] && Object.keys(n['winner-name']).length) winners++;
      }
      if (r.notices.length < 100 || page * 100 >= total) break;
    }
    console.log(`  ${String(total).padStart(5)}  the whole list, any code on the notice`);
    console.log(`  ${String(mainHits).padStart(5)}  of those, the procedure's main classification is on the list`);
    console.log(`  ${String(winners).padStart(5)}  of those, naming a winner`);
  }
  process.exit(bad ? 1 : 0);
})();
