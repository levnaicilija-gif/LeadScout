/**
 * One-off codemod: move `.not('status', 'in', '("stale","not_for_us")')` on a LEADS query onto the
 * workspace's own state row, because 0049 dropped leads.status.
 *
 *   node scripts/codemod-lead-status-filter.mjs <file> [<file> …]
 *   node scripts/codemod-lead-status-filter.mjs --check <file>      # report, change nothing
 *
 * WHY A CODEMOD AND NOT TWENTY EDITS BY HAND. The change is identical in every file — add the state
 * embed to the select, qualify the filter, add the import — and twenty hand edits is twenty chances to
 * get one subtly wrong. It is also deliberately NOT a perl one-liner: the replacement contains
 * `${LEAD_STATE_EMBED}`, and a shell one-liner eats `${…}` — which happened twice in this session and
 * left two selects with an unterminated template literal.
 *
 * It refuses rather than guesses: a file whose leads chain it cannot find is reported and left alone.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const CHECK = process.argv.includes('--check');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const OLD_FILTER = /\.not\(\s*'status'\s*,\s*'in'\s*,\s*(?:'\("stale","not_for_us"\)'|OPEN|CLOSED_LEAD_STATUSES)\s*\)/g;
const NEW_FILTER = '.not(`${LEAD_STATE_TABLE}.status`, \'in\', CLOSED_LEAD_STATUSES)';
const IMPORT = "import { CLOSED_LEAD_STATUSES, LEAD_STATE_EMBED, LEAD_STATE_TABLE } from '../src/lib/workspace-state';";

let changed = 0;
let skipped = 0;

for (const file of files) {
  let src = readFileSync(file, 'utf8');
  const before = src;

  if (!OLD_FILTER.test(src)) { console.log(`skip  ${file} — no leads status filter of the expected shape`); skipped++; continue; }
  OLD_FILTER.lastIndex = 0;

  // 1. The filter.
  src = src.replace(OLD_FILTER, NEW_FILTER);

  // 2. The select on the SAME leads query needs the embed, or the filter has nothing to bite on.
  //    Only the select that directly follows a `.from('leads')` is touched.
  const fromLeads = /\.from\(\s*'leads'\s*\)\s*\.select\(\s*/g;
  let m;
  let out = '';
  let last = 0;
  let embeds = 0;
  while ((m = fromLeads.exec(src))) {
    const start = m.index + m[0].length;
    const q = src[start];
    if (q !== "'" && q !== '`' && q !== '"') continue;      // a variable: left alone
    // Read to the closing quote of the same kind.
    let end = -1;
    for (let j = start + 1; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === q) { end = j; break; }
    }
    if (end === -1) continue;
    const body = src.slice(start + 1, end);
    if (body.includes('workspace_lead_state')) continue;    // already done
    out += src.slice(last, start);
    out += '`' + body + ', ${LEAD_STATE_EMBED}`';
    last = end + 1;
    embeds++;
  }
  out += src.slice(last);
  src = out;

  // 3. The import, after the last existing import so it cannot land above a 'use' directive.
  if (!src.includes("from '../src/lib/workspace-state'")) {
    const imports = [...src.matchAll(/^import .*$/gm)];
    if (!imports.length) { console.log(`SKIP  ${file} — no import line to anchor to`); skipped++; continue; }
    const at = imports[imports.length - 1].index + imports[imports.length - 1][0].length;
    src = src.slice(0, at) + '\n' + IMPORT + src.slice(at);
  }

  if (src === before) { console.log(`skip  ${file} — nothing to change`); skipped++; continue; }
  if (CHECK) { console.log(`would change  ${file} — ${embeds} select(s) given the embed`); changed++; continue; }
  writeFileSync(file, src);
  console.log(`ok    ${file} — ${embeds} select(s) given the embed`);
  changed++;
}

console.log(`\n${changed} changed, ${skipped} skipped`);
