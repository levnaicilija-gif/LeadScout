/**
 * Every PAGED read reads its error. A failed page must never look like "no more rows".
 *
 *   npx tsx scripts/paged-read-check.ts
 *   npx tsx scripts/paged-read-check.ts --self-test
 *
 * THE CLASS, which this codebase has now met at least four times. A loop reads 1,000 rows at a time with
 * `.range(from, from + 999)` and stops when a page comes back short or empty. PostgREST returns
 * `{ data: null, error }` on a failure — so `if (!data) break` cannot tell a failed page from the end of the
 * table, and the loop ends early with a SHORT result that every later line treats as complete. Nothing
 * throws, nothing is logged, and the run reports the smaller answer as if it were the truth.
 *
 * Measured on the real database on 2026-09-28, in the instance that earned this check: the ops-relevant
 * contacts read returns 1,000 rows on page 1 and 585 on page 2, and a failing read of the same shape comes
 * back `42703` WITH `data === null`. A failure on page 2 therefore dropped 585 of 1,585 company names — 37%
 * of the filter deciding which companies were eligible for PAID website discovery — in silence.
 *
 * WHY A CHECK RATHER THAN THREE MORE PATCHES. `resolve-domains` already had the correct version 35 lines
 * BELOW the broken one, carrying the comment "An unread error here would look exactly like 'no more
 * candidates' and silently end the queue early — the class this codebase keeps meeting". The rule was known
 * and written down; what failed was carrying it to a second site in the same function. A patch fixes the
 * sites that exist. This fails the gate on the next one.
 *
 * IT UNDER-MATCHES ON PURPOSE, and that is a decision rather than a limitation. A source scan can be made
 * to flag every paged read by being loose about what counts as one, at the cost of reporting correct code —
 * and a check that cries wolf gets disabled, which is how the class survives. So a read whose destructure
 * this cannot parse with confidence is COUNTED and printed as unjudged, never reported as a defect and
 * never silently passed. The count is the honest statement of the blind spot, exactly as
 * column-exists-check prints its `select('*')` total every run.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Finding = { file: string; line: number; text: string };

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === '.next' || e === '.git' || e === '.cache') continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * A paged read is `.range(` on a statement that destructures the result. The destructure may sit on the
 * same line or up to two lines above, which covers every shape in this codebase; anything else is unjudged.
 *
 * `allRows()` IS JUDGED TOO, AND THAT IS THE POINT (owner's instruction, 2026-09-28). The first draft skipped
 * every `allRows` caller on the theory that it "does the paging correctly", and that theory is wrong in the
 * one way that matters: on a mid-read failure `allRows` returns `{ data: out, error }` — THE ROWS IT MANAGED
 * ALONG WITH the error. A caller that reads only `data` therefore gets a SILENTLY SHORT LIST, which is worse
 * than an empty one because it looks like a complete answer. That is exactly `verify/attach`'s GET handler,
 * whose short list becomes a missing duplicate suggestion and a second record for a person already on file.
 *
 * So a call to `allRows` is a paged read like any other, and is skipped ONLY when the caller reads its error.
 * (The first draft would also have missed it by accident: its skip pattern was `/allRows\s*\(/`, which does
 * not match `allRows<T>(` — the generic defeated it. Making the skip generic-aware would have HIDDEN the bug
 * rather than found it, which is why the rule changed instead of the regex.)
 */
export function findPagedReads(src: string, file: string): { good: Finding[]; bad: Finding[]; unjudged: Finding[] } {
  const good: Finding[] = [];
  const bad: Finding[] = [];
  const unjudged: Finding[] = [];
  const lines = src.split(/\r?\n/);

  // BLOCK COMMENTS ARE NOT CODE, and this file learned that the hard way: candidate-pool-read.ts's own doc
  // comment QUOTES the broken read it exists to prevent — `const { data: existing } = await allRows(...)` —
  // and the first run reported that prose as a defect in the file that fixes it. Tracked line by line rather
  // than stripped, so every line number stays true; column-exists-check makes the same point about a rule
  // quoted in a comment being unable to satisfy a check.
  const inBlockComment: boolean[] = [];
  let open = false;
  for (const line of lines) {
    const startsOpen = open;
    // Crude but sufficient for this codebase: no /* inside a string on these lines.
    let l = line;
    for (;;) {
      if (!open) { const s = l.indexOf('/*'); if (s === -1) break; open = true; l = l.slice(s + 2); }
      else { const e = l.indexOf('*/'); if (e === -1) break; open = false; l = l.slice(e + 2); }
    }
    inBlockComment.push(startsOpen || open);
  }

  lines.forEach((line, i) => {
    if (inBlockComment[i]) return;
    // A paged read is either a raw `.range(` or a call to allRows — which pages for you and hands BACK the
    // error, so its caller must read it just the same.
    const code = line.replace(/\/\/.*$/, '');
    const isPaged = code.includes('.range(') || /\ballRows\s*[<(]/.test(code);
    if (!isPaged) return;
    // A line that only DEFINES the helper, or passes a range through to it, is not a call site. The helper
    // itself reads its error internally, which is what makes it the fix.
    if (/export\s+(async\s+)?function\s+allRows/.test(code)) return;

    // ONE STATEMENT, ONE JUDGEMENT. An allRows call spans lines — the destructure on the first, the
    // `.range(` inside the arrow several lines below — and counting both reported readPoolForMatching, which
    // reads its error correctly, as BOTH good and bad. So a `.range(` belonging to an allRows call above it
    // is that call's business, already judged at the destructure. Found by the check's own first clean run
    // against fixed code, which is the only reason it did not become a false alarm somebody switched off.
    if (code.includes('.range(') && !/\ballRows\s*[<(]/.test(code)) {
      const above = [lines[i - 1] ?? '', lines[i - 2] ?? '', lines[i - 3] ?? '', lines[i - 4] ?? ''].join('\n');
      if (/\ballRows\s*[<(]/.test(above)) return;
    }

    // THE DESTRUCTURE MUST BELONG TO THIS STATEMENT, not merely sit near it. A fixed two-line lookback
    // reported email-patterns-backfill's paged read as unguarded because the PREVIOUS statement — a complete
    // `const { data: ws } = await ...;` one line above — was inside the window, while the read itself calls a
    // local `all()` helper that reads its error and throws. So the walk back stops at a statement boundary: a
    // line ending in `;`, `{` or `}` closes the previous statement and cannot be part of this one. The result
    // is that a read with no destructure of its own becomes UNJUDGED rather than a false alarm, which is the
    // under-match bias doing its job — a check that flags correct code is a check somebody switches off.
    const parts = [code];
    for (let k = i - 1; k >= 0 && i - k <= 4; k--) {
      const prev = (lines[k] ?? '').replace(/\/\/.*$/, '').trimEnd();
      if (/[;{}]$/.test(prev)) break;
      parts.unshift(prev);
    }
    const destructure = parts.join('\n').match(/const\s*\{([^}]*)\}\s*=\s*await/);
    const text = code.trim().slice(0, 120);
    if (!destructure) { unjudged.push({ file, line: i + 1, text }); return; }
    const names = destructure[1];
    if (!/\berror\b/.test(names)) { bad.push({ file, line: i + 1, text }); return; }

    // DESTRUCTURING IT IS NOT READING IT, and this arm exists because the author of this check fell into
    // exactly that on 2026-09-28: sweeping the remaining sites, four scripts gained `error: pageErr` and
    // never referenced it again, and the check went GREEN on the declaration alone. A name bound and never
    // used is the same silence as no name at all, so the identifier must appear again below.
    const bound = names.match(/\berror\s*:\s*([A-Za-z_$][\w$]*)/);
    const ident = bound ? bound[1] : 'error';
    // HOW FAR TO LOOK depends on how distinctive the name is, which is not fussiness. An ALIAS like
    // `sourcesError` or `pageErr` is unique enough to search the whole rest of the file — and it must be,
    // because settings/page.tsx binds one and handles it 26 lines later inside JSX, which a short window
    // reported as unused. The bare name `error` recurs in almost every file, so searching file-wide for it
    // would pass any bad read that happens to sit above an unrelated `error`; it gets a window instead.
    const below = bound ? lines.slice(i + 1).join('\n') : lines.slice(i + 1, i + 13).join('\n');
    // The handling can also sit on the destructure line itself, after the closing brace.
    const used = new RegExp(`\\b${ident}\\b`).test(below) || new RegExp(`\\b${ident}\\b[^:]*$`).test(code.slice(code.indexOf('}')));
    if (used) good.push({ file, line: i + 1, text });
    else bad.push({ file, line: i + 1, text: `${text}   [binds "${ident}" and never uses it]` });
  });

  return { good, bad, unjudged };
}

/* ------------------------------------------------------------------ the self-test */

function selfTest(): number {
  let fail = 0;
  const say = (ok: boolean, what: string, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
    if (!ok) fail++;
  };
  console.log('--- the checker, pointed at loops that do and do not read their error ---');

  // THE EXACT SHAPE THAT WAS BROKEN, beside the exact shape that was correct, in one fixture — because the
  // real file contained both and the check must tell them apart rather than flag the file.
  const both = findPagedReads(`
    for (let from = 0; ; from += 1000) {
      const { data } = await db.from('people').select('company_name').range(from, from + 999);
      if (!data || !data.length) break;
    }
    for (let from = 0; ; from += 1000) {
      const { data, error } = await page(from).range(from, from + 999);
      if (error) return fail(error);
    }
  `, 'self-test');
  say(both.bad.length === 1 && both.good.length === 1,
    'the unread loop is reported and the correct one beside it is NOT', `bad ${both.bad.length}, good ${both.good.length}`);
  say(both.bad[0]?.line === 3, 'and it names the right line', `line ${both.bad[0]?.line}`);

  // An ALIASED error is read, and must not be reported — this is how H1 was actually fixed.
  const aliased = findPagedReads(`const { data, error: opsErr } = await db.from('people').select('company_name').range(0, 999);
  if (opsErr) throw new Error(opsErr.message);`, 'self-test');
  say(aliased.good.length === 1 && aliased.bad.length === 0, 'an aliased error (error: opsErr) counts as read', JSON.stringify({ good: aliased.good.length, bad: aliased.bad.length }));

  // A multi-line destructure, the common formatting in this codebase.
  const multi = findPagedReads(`
    const { data, error } = await db
      .from('leads').select('*')
      .range(from, from + 999);
    if (error) return fail(error);
  `, 'self-test');
  say(multi.good.length === 1 && multi.bad.length === 0, 'a destructure two lines above the .range( is found', JSON.stringify({ good: multi.good.length, bad: multi.bad.length, unjudged: multi.unjudged.length }));

  // ALLROWS IS JUDGED, NOT SKIPPED. On a mid-read failure it returns the rows it managed ALONG WITH the
  // error, so a caller reading only `data` gets a silently short list. This is the arm the owner asked for.
  const allRowsIgnored = findPagedReads(
    `const { data: known } = await allRows<{ id: string }>((from, to) => db.from('candidates').select('id').range(from, to));`, 'self-test');
  say(allRowsIgnored.bad.length === 1,
    'an allRows call that IGNORES the error FAILS — a short list looks like a complete answer',
    `bad ${allRowsIgnored.bad.length}, good ${allRowsIgnored.good.length}, unjudged ${allRowsIgnored.unjudged.length}`);
  // And the generic form specifically, because the first draft's skip pattern `/allRows\s*\(/` did not match
  // `allRows<T>(` — the bug would have been hidden by a narrower regex rather than found.
  say(/allRows<\{/.test(`const { data } = await allRows<{ id: string }>(...)`) && allRowsIgnored.bad.length === 1,
    'and the GENERIC form allRows<T>( is reached — the shape the first draft skipped by accident', 'judged, not skipped');
  const allRowsRead = findPagedReads(
    `const { data, error } = await allRows<any>((from, to) => db.from('candidates').select('id').range(from, to));
  if (error) return { known: [], error: error.message };`, 'self-test');
  say(allRowsRead.good.length === 1 && allRowsRead.bad.length === 0,
    'an allRows call that READS its error passes — the only allRows caller that is skipped', `good ${allRowsRead.good.length}`);
  // The helper's own definition is not a call site: it reads its error internally, which is the fix.
  const helper = findPagedReads(`export async function allRows<T = any>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>) {`, 'self-test');
  say(helper.bad.length === 0, 'allRows’ own definition is not reported as a defect', `bad ${helper.bad.length}`);

  // UNDER-MATCHING, asserted rather than hoped for: a shape it cannot parse is COUNTED, never passed.
  // REAL table and column names, even in fixtures. With `from('x').select('y')` this file failed
  // column-exists-check, which scans scripts/ and quite rightly reported that no such table or column
  // exists — a check breaking another check. column-exists-check exempts its OWN file for this reason and
  // cannot know about this one, so the fixtures name something real instead of an exemption being added:
  // an exemption list is a place for the next fixture to hide.
  const weird = findPagedReads(`const r = await db.from('people').select('company_name').range(0, 999);`, 'self-test');
  say(weird.unjudged.length === 1 && weird.bad.length === 0,
    'a result NOT destructured is counted as unjudged rather than reported as a defect', `unjudged ${weird.unjudged.length}`);

  // A comment mentioning .range( is not a read.
  const comment = findPagedReads(`// paged with .range(from, from + 999) because PostgREST caps at 1000`, 'self-test');
  say(comment.good.length + comment.bad.length + comment.unjudged.length === 0, 'a comment mentioning .range( is ignored');

  console.log(fail ? `\nself-test: ${fail} FAILED` : '\nself-test: all checks passed');
  return fail;
}

/* ------------------------------------------------------------------ main */

if (process.argv.includes('--self-test')) {
  process.exitCode = selfTest() ? 1 : 0;
} else {
  let good = 0; let unjudged = 0;
  const bad: Finding[] = [];
  const unjudgedList: Finding[] = [];
  for (const dir of ['src', 'scripts']) {
    for (const file of sourceFiles(dir)) {
      const at = file.replace(/\\/g, '/');
      // This file carries broken fixtures ON PURPOSE, in its self-test.
      if (at.endsWith('scripts/paged-read-check.ts')) continue;
      const r = findPagedReads(readFileSync(file, 'utf8'), at);
      good += r.good.length;
      unjudged += r.unjudged.length;
      bad.push(...r.bad);
      unjudgedList.push(...r.unjudged);
    }
  }
  console.log(`${good + bad.length + unjudged} paged read(s) found: ${good} read their error, ${bad.length} do not`);
  console.log(`  not judged: ${unjudged} whose destructure could not be parsed with confidence — counted rather than passed`);
  for (const u of unjudgedList.slice(0, 10)) console.log(`    ${u.file}:${u.line}  ${u.text}`);
  if (bad.length) {
    console.log('');
    for (const b of bad) {
      console.log(`FAIL  ${b.file}:${b.line} pages with .range( and does not read its error — a failed page will look like "no more rows"`);
      console.log(`        ${b.text}`);
    }
    console.log(`\n${bad.length} paged read(s) that would end early and in silence`);
    process.exitCode = 1;
  } else {
    console.log('\nevery paged read this can judge reads its error');
  }
}
