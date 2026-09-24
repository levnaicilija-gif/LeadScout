/**
 * Every column this codebase NAMES in a literal .select() exists in the live schema.
 *
 *   npx tsx --env-file=.env.local scripts/column-exists-check.ts
 *   npx tsx --env-file=.env.local scripts/column-exists-check.ts --self-test
 *
 * WHY THIS EXISTS, and it is not a style check. 04cf363 recorded the three shapes a dropped or
 * renamed column takes, hardest to notice last:
 *
 *   .update({ col })            always fails — loud, immediate
 *   .select('a, col, c')        fails the WHOLE query — loud, but takes the screen with it
 *   .select('*') + row.col      FAILS SILENTLY — undefined, no error, nothing in a log
 *
 * 0047 hit the middle one on six live sites and took two crawl jobs down. Item 20 step 2c removes
 * `leads.status`, `confirmed_by`, `confirmed_at`, `job_description`, `jd_version` and the company's
 * hiring and override columns, so the same trap is directly ahead — and the absence of errors after
 * that migration will prove nothing, because the reads that break loudest are the ones this check
 * covers while the ones that break silently are the ones it cannot.
 *
 * WHAT IT CANNOT DO, said here rather than discovered later. It reads LITERAL selects only:
 *
 *   - `select('*')` is unknowable. A star names no column, so nothing can be asserted about it, and
 *     it is exactly the shape that fails silently. The count is REPORTED every run so the size of
 *     the blind spot is visible rather than implied.
 *   - a template literal — select(`a, ${cols}`) — is not read, because the interpolated half is only
 *     known at run time. Counted and reported for the same reason. This codebase builds several
 *     selects that way behind hasColumn guards, which is a deliberate pattern, not an oversight.
 *
 * So a clean run means "no literally-named column is missing", never "no column is missing". That
 * distinction is the whole reason the count is printed instead of a bare pass.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

type Site = { file: string; line: number; table: string; select: string };
type Problem = { file: string; line: number; table: string; column: string; why: string };

/* ------------------------------------------------------------------ finding the sites */

/**
 * Every `.from('t')` whose next call is a `.select('literal')`.
 *
 * The window stops at the next `.from(`, so a select belonging to a later query can never be
 * attributed to an earlier table — which would invent a failure rather than miss one.
 */
export function findSites(source: string, file = '<inline>'): { sites: Site[]; star: number; dynamic: number } {
  const sites: Site[] = [];
  let star = 0;
  let dynamic = 0;
  const from = /\.from\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = from.exec(source))) {
    const table = m[1];
    const after = source.slice(m.index + m[0].length);
    const nextFrom = after.search(/\.from\(\s*['"]/);
    const window = nextFrom === -1 ? after : after.slice(0, nextFrom);
    // The select must be the NEXT call, allowing whitespace and line breaks between.
    const sel = /^\s*\.select\(\s*/.exec(window);
    if (!sel) continue;
    const rest = window.slice(sel[0].length);
    const line = source.slice(0, m.index).split('\n').length;
    const q = rest[0];
    if (q === '`') { dynamic++; continue; }            // template literal — unknowable until run time
    if (q !== "'" && q !== '"') { dynamic++; continue; } // a variable: select(cols as '*')
    // Read the literal, honouring escapes.
    let out = '';
    let i = 1;
    for (; i < rest.length; i++) {
      const c = rest[i];
      if (c === '\\') { out += rest[i + 1]; i++; continue; }
      if (c === q) break;
      out += c;
    }
    if (i >= rest.length) { dynamic++; continue; }
    if (out.trim() === '*') { star++; continue; }
    sites.push({ file, line, table, select: out });
  }
  return { sites, star, dynamic };
}

/* ------------------------------------------------------------------ reading a select */

/** Split on commas that are OUTSIDE any embed's parentheses. */
function splitFields(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((f) => f.trim()).filter(Boolean);
}

/**
 * Check one select against one table, descending into every embed.
 *
 * PostgREST's field grammar, only as far as this codebase uses it:
 *   [alias:]name[!hint][(nested)][::cast]
 * `!inner` and `!left` are join modifiers; any other `!x` names a foreign key or disambiguates a
 * relationship. Either way the part before `!` is the table the embed reads.
 */
export function checkSelect(
  table: string,
  select: string,
  columnsOf: (t: string) => Set<string> | null,
  at: { file: string; line: number },
  problems: Problem[],
) {
  const cols = columnsOf(table);
  if (!cols) {
    problems.push({ ...at, table, column: '(the table itself)', why: `no table called "${table}" is in the live schema` });
    return;
  }
  for (const raw of splitFields(select)) {
    let field = raw;
    // An alias, but never a `::cast`.
    const colon = field.search(/:(?!:)/);
    if (colon > 0 && !field.slice(0, colon).includes('(')) field = field.slice(colon + 1).trim();
    field = field.split('::')[0].trim();

    const paren = field.indexOf('(');
    if (paren === -1) {
      // A JSON path — `extracted->>holder`, `profile->trade` — names the COLUMN before the arrow and
      // then reaches inside its jsonb. Only the column can be checked; what is under it has no
      // schema to check against. Found by this check's first real run, which reported
      // documents.extracted->>holder as a missing column when `extracted` exists and is jsonb.
      const name = field.split('!')[0].split('->')[0].trim();
      if (!name || name === '*' || name.startsWith('...')) continue;
      if (!cols.has(name)) {
        problems.push({ ...at, table, column: name, why: `"${table}" has no column "${name}"` });
      }
      continue;
    }
    // An embed: recurse into the table it names.
    const head = field.slice(0, paren).trim();
    const body = field.slice(paren + 1, field.lastIndexOf(')'));
    const embed = head.split('!')[0].trim();
    if (!embed) continue;
    if (!columnsOf(embed)) {
      // Not a table. It may be a relationship named something else, which this check cannot resolve
      // — reported as unresolved rather than as a missing column, because guessing either way would
      // be worse than saying so.
      problems.push({ ...at, table, column: `${embed}(…)`, why: `embedded "${embed}" is not a table in the live schema — relationship aliases cannot be resolved here` });
      continue;
    }
    checkSelect(embed, body, columnsOf, at, problems);
  }
}

/* ------------------------------------------------------------------ the run */

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { out.push(...sourceFiles(p)); continue; }
    if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

/**
 * The mutation, run with --self-test.
 *
 * A check that only ever passes is indistinguishable from a check that does nothing, which this
 * codebase has now been caught by three times. So the checker is pointed at a column that does not
 * exist and REQUIRED to fail with a message naming it — and, just as importantly, required NOT to
 * flag the valid select beside it, since a checker that failed everything would also "catch" the
 * bad one while being useless.
 */
function selfTest(columnsOf: (t: string) => Set<string> | null): number {
  let bad = 0;
  const say = (pass: boolean, what: string, detail: string) => {
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${what} — ${detail}`);
    if (!pass) bad++;
  };

  const run = (src: string) => {
    const problems: Problem[] = [];
    const { sites, star, dynamic } = findSites(src, 'self-test');
    for (const s of sites) checkSelect(s.table, s.select, columnsOf, { file: s.file, line: s.line }, problems);
    return { problems, sites, star, dynamic };
  };

  // 1. A real column is accepted.
  const good = run(`db.from('leads').select('id, project_name, fit_score')`);
  say(good.problems.length === 0 && good.sites.length === 1,
    'a select naming real columns passes',
    `${good.sites.length} site read, ${good.problems.length} problem(s) — the check is not failing everything`);

  // 2. THE MUTATION: a column that does not exist must be caught, and named.
  const missing = run(`db.from('leads').select('id, no_such_column, fit_score')`);
  say(missing.problems.length === 1 && missing.problems[0].column === 'no_such_column',
    'a column that does not exist is CAUGHT',
    missing.problems[0] ? missing.problems[0].why : 'nothing was reported — the check does not work');

  // 3. The same one level down, inside an embed, which is where 0047's six sites lived.
  const embed = run(`db.from('leads').select('id, companies(name, not_a_column)')`);
  say(embed.problems.length === 1 && embed.problems[0].column === 'not_a_column' && embed.problems[0].table === 'companies',
    'a missing column INSIDE an embed is caught, against the embedded table',
    embed.problems[0] ? embed.problems[0].why : 'nothing was reported');

  // 4. The columns item 20 step 2c is about to remove — the reason this check was built now.
  //    They exist TODAY, so this asserts the check is watching them; after the drop it must flag
  //    any site still naming them.
  const twoC = run(`db.from('leads').select('id, status, confirmed_by, confirmed_at, job_description, jd_version')`);
  say(twoC.problems.length === 0,
    "2c's columns are named and currently exist",
    `status, confirmed_by, confirmed_at, job_description, jd_version all present — after the drop this same select must fail`);

  // 4b. THE REAL ONE. companies.rfbt_history was renamed to sector_note by 0047, and the six live
  //     sites still naming it took two crawl jobs down — the incident this whole check exists for.
  //     A synthetic "no_such_column" proves the mechanism; this proves it against the exact failure
  //     that actually happened, using a column that really was removed from this database.
  const historical = run(`db.from('companies').select('id, name, rfbt_history')`);
  say(historical.problems.length === 1 && historical.problems[0].column === 'rfbt_history',
    "0047's renamed column would have been caught before it shipped",
    historical.problems[0] ? historical.problems[0].why : 'NOT caught — the check would not have prevented the incident it was built for');
  const renamed = run(`db.from('companies').select('id, name, sector_note')`);
  say(renamed.problems.length === 0, 'and its new name passes', `${renamed.problems.length} problem(s) — sector_note is what the column is called now`);

  // 5. Aliases, casts, !inner and nested embeds are read, not mistaken for columns.
  const grammar = run(`db.from('verifications').select('id, documents!inner(uploaded_by, workspace_id)')`);
  say(grammar.problems.length === 0, 'an !inner embed is read as a table, not a column', `${grammar.problems.length} problem(s)`);

  // 6. A JSON path is its base column — and the fix for that must not blanket-accept an arrow.
  //    Both directions, because "ignore anything containing ->" would pass the first and break the
  //    second, and only the first would have been noticed.
  const json = run(`db.from('documents').select('id, extracted->>holder, extracted->number')`);
  say(json.problems.length === 0, 'a JSON path is read as its base column', `${json.problems.length} problem(s) — extracted exists and is jsonb`);
  const jsonBad = run(`db.from('documents').select('id, not_a_column->>holder')`);
  say(jsonBad.problems.length === 1 && jsonBad.problems[0].column === 'not_a_column',
    'a JSON path on a column that does NOT exist is still caught',
    jsonBad.problems[0] ? jsonBad.problems[0].why : 'nothing was reported — the arrow fix swallowed it');

  // 7. The blind spots are COUNTED, not silently skipped.
  const blind = run("db.from('leads').select('*')\ndb.from('leads').select(`id, ${x}`)");
  say(blind.star === 1 && blind.dynamic === 1 && blind.sites.length === 0,
    'a star and a template literal are counted as blind spots',
    `star ${blind.star}, dynamic ${blind.dynamic} — neither is checked, and neither is hidden`);

  // 8. A select belonging to a LATER query is never attributed to an earlier table.
  const window = run(`db.from('leads').update({ a: 1 })\ndb.from('companies').select('name')`);
  say(window.sites.length === 1 && window.sites[0].table === 'companies',
    'an update is not mistaken for a select on the same table',
    `${window.sites.length} site read, table "${window.sites[0]?.table}"`);

  console.log(`\nself-test: ${bad === 0 ? 'the check demonstrably catches a missing column' : `${bad} failure(s)`}`);
  return bad;
}

async function main() {
  if (!url || !key) { console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'); process.exitCode = 1; return; }
  const res = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) { console.error(`could not read the API spec: HTTP ${res.status}`); process.exitCode = 1; return; }
  const spec: any = await res.json();
  const defs = spec?.definitions ?? {};
  const cache = new Map<string, Set<string> | null>();
  const columnsOf = (t: string): Set<string> | null => {
    if (!cache.has(t)) cache.set(t, defs[t] ? new Set(Object.keys(defs[t].properties ?? {})) : null);
    return cache.get(t)!;
  };

  if (process.argv.includes('--self-test')) { process.exitCode = selfTest(columnsOf) ? 1 : 0; return; }

  const problems: Problem[] = [];
  let sites = 0;
  let star = 0;
  let dynamic = 0;
  for (const file of sourceFiles('src')) {
    const src = readFileSync(file, 'utf8');
    const found = findSites(src, file.replace(/\\/g, '/'));
    star += found.star;
    dynamic += found.dynamic;
    sites += found.sites.length;
    for (const s of found.sites) checkSelect(s.table, s.select, columnsOf, { file: s.file, line: s.line }, problems);
  }

  console.log(`${sites} literal select(s) read across ${Object.keys(defs).length} live tables`);
  console.log(`  not checked: ${star} select('*') — names no column, and this is the shape that fails SILENTLY`);
  console.log(`  not checked: ${dynamic} built from a template literal or a variable — only known at run time`);
  if (problems.length) {
    console.log('');
    for (const p of problems) console.log(`  FAIL  ${p.file}:${p.line} — ${p.why}`);
    console.log(`\n${problems.length} named column(s) do not exist`);
    process.exitCode = 1;
    return;
  }
  console.log('\nevery literally-named column exists — which is not the same as every column');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
