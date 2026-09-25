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

/**
 * Every `.from('t').insert({…})` / `.update({…})` / `.upsert({…})` and the columns it NAMES.
 *
 * ADDED AFTER A PRODUCTION BREAK, 2026-09-25. 0049 dropped leads.status and this check reported a
 * clean sweep — truthfully, because it only ever read `.select()` calls in src/. Nine gate steps then
 * failed on probes writing `status: 'new'` into leads, and the conclusion drawn from a clean run had
 * been far broader than the run supported. A write naming a dropped column fails LOUDLY, which is the
 * easiest of 04cf363's three shapes to survive — but only if something is watching the writes.
 *
 * Only DEPTH-0 keys are taken. `profile: { trade: 'welder' }` names one column, `profile`, and `trade`
 * belongs to the jsonb inside it, not to the table. A spread — `...(crm ? { owner_id: me.id } : {})` —
 * is skipped rather than guessed at.
 */
export function findWrites(source: string, file = '<inline>'): { sites: (Site & { keys: string[] })[]; dynamic: number } {
  const sites: (Site & { keys: string[] })[] = [];
  let dynamic = 0;
  const from = /\.from\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)\s*\.(insert|update|upsert)\(\s*/g;
  let m: RegExpExecArray | null;
  while ((m = from.exec(source))) {
    const table = m[1];
    const rest = source.slice(m.index + m[0].length);
    // An array of rows — .insert([{…}, {…}]) — is read from its first object.
    let i = 0;
    while (i < rest.length && /\s/.test(rest[i])) i++;
    if (rest[i] === '[') i++;
    while (i < rest.length && /\s/.test(rest[i])) i++;
    if (rest[i] !== '{') { dynamic++; continue; }        // a variable: .update(patch)
    // Walk to the matching brace, tracking strings and template literals so a `}` inside one is not
    // mistaken for the end of the payload.
    let depth = 0; let end = -1; let quote = '';
    for (let j = i; j < rest.length; j++) {
      const c = rest[j];
      if (quote) { if (c === '\\') { j++; continue; } if (c === quote) quote = ''; continue; }
      if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) { dynamic++; continue; }
    const body = rest.slice(i + 1, end);
    // Depth-0 `key:` tokens only.
    const keys: string[] = [];
    let d = 0; let q = '';
    let token = '';
    for (let j = 0; j < body.length; j++) {
      const c = body[j];
      if (q) { if (c === '\\') { j++; continue; } if (c === q) q = ''; continue; }
      if (c === "'" || c === '"' || c === '`') { q = c; token = ''; continue; }
      if (c === '{' || c === '[' || c === '(') { d++; continue; }
      if (c === '}' || c === ']' || c === ')') { d--; continue; }
      if (d !== 0) continue;
      if (c === ',') { token = ''; continue; }
      if (c === ':') {
        const name = token.trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) keys.push(name);
        token = '';
        continue;
      }
      token += c;
    }
    const line = source.slice(0, m.index).split('\n').length;
    if (keys.length) sites.push({ file, line, table, select: '', keys });
  }
  return { sites, dynamic };
}

/**
 * Every column named in a FILTER — `.eq('status', …)`, `.not('status', 'in', …)`, `.is(…)` and the rest.
 *
 * THE THIRD BLIND SPOT, found on 2026-09-25 while fixing the second. A filter on a dropped column
 * fails the query exactly as a select does, and it is a wider surface than selects: compound-signals-
 * census had dropped `status` from its select and still said `.not('status', 'in', …)` on the next
 * line, so removing it from the select had fixed nothing.
 *
 * A qualified name — `workspace_lead_state.status` — is resolved against THAT table, because that is
 * how PostgREST reads an embedded filter, and treating it as a column of the parent would report every
 * correct embedded filter in the codebase as a defect.
 *
 * `.or('a.is.null,b.eq.1')` is NOT read: its columns live inside a string in PostgREST's own grammar,
 * and half-parsing that would invent failures. Counted as a blind spot instead.
 */
const FILTER_OPS = 'eq|neq|gt|gte|lt|lte|like|ilike|is|in|contains|containedBy|overlaps|not|filter|match';

export function findFilters(source: string, file = '<inline>'): { refs: { file: string; line: number; table: string; column: string }[]; dynamic: number } {
  const refs: { file: string; line: number; table: string; column: string }[] = [];
  let dynamic = 0;
  const from = /\.from\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = from.exec(source))) {
    const table = m[1];
    // THE CHAIN IS WALKED, NOT WINDOWED. Two window heuristics were tried and both invented failures:
    // stopping at the next `.from(` attributed radar/page.tsx's `q.not('status', …)` helper to a
    // companies query eight lines above it, and stopping at the next `;` swept every query in a
    // `Promise.all([…])` into the first one — today/page.tsx was reported as filtering leads on
    // `valid_until` and `pii_check_passed`, which belong to two other tables in the same array.
    //
    // So this accepts only a CONTIGUOUS `.name(…)` chain hanging off the `.from()`: anything that is
    // not the next link ends it. A builder reassigned through a variable — `let q = …; q = q.eq(…)` —
    // is therefore NOT followed, and is counted as a blind spot rather than guessed at.
    const after = source.slice(m.index + m[0].length);
    const line = source.slice(0, m.index).split('\n').length;
    const ops = new RegExp(`^(?:${FILTER_OPS})$`);
    let pos = 0;
    for (;;) {
      const link = /^\s*\.\s*([A-Za-z_]\w*)\s*\(/.exec(after.slice(pos));
      if (!link) break;
      const openAt = pos + link[0].length;               // just past the '('
      // Skip to the matching ')', honouring strings so a bracket inside one does not end the call.
      let depth = 1; let quote = ''; let close = -1;
      for (let j = openAt; j < after.length; j++) {
        const c = after[j];
        if (quote) { if (c === '\\') { j++; continue; } if (c === quote) quote = ''; continue; }
        if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) { close = j; break; } }
      }
      if (close === -1) break;
      const args = after.slice(openAt, close);
      const name = link[1];
      if (name === 'or') dynamic++;                      // columns live inside PostgREST's own grammar
      else if (ops.test(name)) {
        const first = /^\s*(['"`])([^'"`]*)\1/.exec(args);
        if (!first) dynamic++;
        else if (first[1] === '`') dynamic++;
        else if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(first[2])) refs.push({ file, line, table, column: first[2] });
      }
      pos = close + 1;
    }
  }
  return { refs, dynamic };
}

/**
 * `new.<column>` and `old.<column>` inside a trigger function, checked against the table its trigger
 * is bound to.
 *
 * THIS IS THE CLASS THAT BROKE PRODUCTION ON 2026-09-25, and it is invisible to every other check
 * here. 0048's trigger read `coalesce(new.status, 'new')`; 0049 dropped leads.status. Postgres does
 * not refuse the drop and does not warn, because a plpgsql trigger field appears in NO catalogue
 * dependency a column drop consults — it is resolved only when the trigger runs. The first sign was
 * every lead insert failing with 42703 in production.
 *
 * So the migrations are read as text: the last definition of each trigger function wins (0050
 * redefines 0048's), the last `create trigger … on <table> … execute function <fn>` binds it, and
 * every field it names must exist on that table today.
 */
export function findTriggerFieldRefs(sql: { file: string; text: string }[]): { fn: string; table: string; field: string; file: string }[] {
  const bodies = new Map<string, { text: string; file: string }>();
  const bound = new Map<string, { table: string; file: string }>();
  // Files in migration order, so a later redefinition replaces an earlier one.
  for (const { file, text } of [...sql].sort((a, b) => a.file.localeCompare(b.file))) {
    const fnRe = /create\s+or\s+replace\s+function\s+(?:public\.)?(\w+)\s*\([^)]*\)\s*returns\s+trigger[\s\S]*?\$\$([\s\S]*?)\$\$/gi;
    let f: RegExpExecArray | null;
    while ((f = fnRe.exec(text))) bodies.set(f[1].toLowerCase(), { text: f[2], file });
    const trRe = /create\s+trigger\s+\w+[\s\S]{0,200}?\son\s+(\w+)[\s\S]{0,200}?execute\s+(?:function|procedure)\s+(?:public\.)?(\w+)\s*\(/gi;
    let t: RegExpExecArray | null;
    while ((t = trRe.exec(text))) bound.set(t[2].toLowerCase(), { table: t[1], file });
  }
  const out: { fn: string; table: string; field: string; file: string }[] = [];
  for (const [fn, body] of bodies) {
    const b = bound.get(fn);
    if (!b) continue;                                     // a trigger function nothing binds: nothing to check against
    const seen = new Set<string>();
    for (const m of body.text.matchAll(/\b(?:new|old)\.(\w+)/gi)) {
      const field = m[1].toLowerCase();
      if (seen.has(field)) continue;
      seen.add(field);
      out.push({ fn, table: b.table, field, file: body.file });
    }
  }
  return out;
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

function sourceFiles(dir: string, match = /\.(ts|tsx)$/): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { out.push(...sourceFiles(p, match)); continue; }
    if (match.test(e)) out.push(p);
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

  // 4. The columns item 20 step 2c removed. This assertion has been INVERTED, and the inversion is
  //    the point rather than a maintenance chore.
  //
  //    Until 0049 it read the other way round — "these are named and currently exist" — which is what
  //    made the check demonstrably watching them while they were still there. 0049 dropped them and
  //    this assertion duly failed, on its own terms, exactly as its own comment said it would. So it
  //    now asserts what must hold for ever after: a select naming any of the five is CAUGHT.
  //
  //    That makes it a permanent regression guard rather than a one-off. Anyone who reintroduces
  //    leads.status in a literal select — restoring an old file, copying a pre-0049 snippet, writing
  //    from memory — fails here instead of taking a screen down in production.
  const twoC = run(`db.from('leads').select('id, status, confirmed_by, confirmed_at, job_description, jd_version')`);
  const caught = new Set(twoC.problems.map((p) => p.column));
  const expected = ['status', 'confirmed_by', 'confirmed_at', 'job_description', 'jd_version'];
  say(expected.every((c) => caught.has(c)),
    "2c's dropped columns are caught, every one of them",
    `named 5, caught ${twoC.problems.length}: ${[...caught].join(', ') || 'NONE — the drop is invisible to this check'}`);

  // And the company half, which is the one whose index nearly went unnoticed.
  const twoCco = run(`db.from('companies').select('id, hiring_status, employer_type_override, employer_type_set_at')`);
  say(twoCco.problems.length === 3,
    "and the company half too",
    `caught ${twoCco.problems.map((p) => p.column).join(', ') || 'NONE'}`);

  // The one that STAYED must not be caught, or the check would be reporting a column that is there —
  // which would be the same defect in the opposite direction, and would make the line above useless.
  const kept = run(`db.from('companies').select('id, employer_type, employer_type_reason, sector_note')`);
  say(kept.problems.length === 0,
    'while the columns 0049 deliberately KEPT still pass',
    `employer_type, employer_type_reason (525 shared crawl rows) and sector_note — ${kept.problems.length} problem(s)`);

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

  // ---- writes, added after the 2026-09-25 break -------------------------------------------------
  const runW = (src: string) => {
    const problems: Problem[] = [];
    const { sites, dynamic } = findWrites(src, 'self-test');
    for (const s of sites) {
      const cols = columnsOf(s.table);
      if (!cols) continue;
      for (const k of s.keys) if (!cols.has(k)) problems.push({ file: s.file, line: s.line, table: s.table, column: k, why: `"${s.table}" has no column "${k}"` });
    }
    return { problems, sites, dynamic };
  };

  // THE EXACT BREAK: nine gate steps failed on probes writing this, and nothing was watching writes.
  const wBad = runW(`db.from('leads').insert({ workspace_id: w, kind: 'won_work', status: 'new' })`);
  say(wBad.problems.length === 1 && wBad.problems[0].column === 'status',
    'a WRITE naming a dropped column is caught',
    wBad.problems[0] ? wBad.problems[0].why : 'NOT caught — this is the shape that failed nine gate steps on 2026-09-25');

  const wOk = runW(`db.from('leads').insert({ workspace_id: w, kind: 'won_work', fit_score: 60 })`);
  say(wOk.problems.length === 0, 'and a write naming real columns passes', `${wOk.problems.length} problem(s)`);

  // An array of rows, which is how most seeds are written.
  const wArr = runW(`db.from('leads').insert([{ kind: 'won_work', status: 'new' }, { kind: 'won_work' }])`);
  say(wArr.problems.length === 1, 'a write given an ARRAY of rows is read from its first row', `${wArr.problems.length} problem(s)`);

  // Depth matters: a jsonb column's inner keys are NOT columns of the table.
  const wNest = runW(`db.from('candidates').insert({ workspace_id: w, profile: { trade: 'welder', status: 'nonsense' } })`);
  say(wNest.problems.length === 0, 'keys inside a jsonb value are not mistaken for columns', `profile.trade and profile.status ignored — ${wNest.problems.length} problem(s)`);

  // A variable payload cannot be read and must be COUNTED, not silently passed.
  const wVar = runW(`db.from('companies').update(patch).eq('id', x)`);
  say(wVar.dynamic === 1 && wVar.sites.length === 0, 'a variable payload is counted as a blind spot', `dynamic ${wVar.dynamic}`);

  // ---- the trigger-record class, which is why production broke -----------------------------------
  const TRIG_BROKEN = [{
    file: '0048_x.sql',
    text: `create or replace function public.lead_state_row() returns trigger
language plpgsql as $$ begin
  insert into workspace_lead_state (workspace_id, lead_id, status)
  values (new.workspace_id, new.id, coalesce(new.status, 'new'));
  return new; end $$;
create trigger leads_state_row after insert on leads for each row execute function public.lead_state_row();`,
  }];
  const broken = findTriggerFieldRefs(TRIG_BROKEN).filter((r) => { const c = columnsOf(r.table); return c && !c.has(r.field); });
  say(broken.some((r) => r.field === 'status' && r.table === 'leads'),
    'THE PRODUCTION BREAK: a trigger reading new.status on leads is caught',
    broken.length ? broken.map((r) => `${r.fn}() reads new.${r.field} on ${r.table}`).join('; ') : 'NOT caught — 0049 would break every lead insert again');

  // And 0050's fixed version must be clean, or the check would flag the fix as the bug.
  const TRIG_FIXED = [{
    file: '0050_x.sql',
    text: `create or replace function public.lead_state_row() returns trigger
language plpgsql as $$ begin
  insert into workspace_lead_state (workspace_id, lead_id)
  values (new.workspace_id, new.id);
  return new; end $$;
create trigger leads_state_row after insert on leads for each row execute function public.lead_state_row();`,
  }];
  const fixed = findTriggerFieldRefs(TRIG_FIXED).filter((r) => { const c = columnsOf(r.table); return c && !c.has(r.field); });
  say(fixed.length === 0, "and 0050's fixed trigger is clean", `${fixed.length} problem(s) — it reads only workspace_id and id`);

  // A LATER redefinition must win, which is the whole reason 0050 fixes 0048 rather than editing it.
  const bothRefs = findTriggerFieldRefs([...TRIG_BROKEN, ...TRIG_FIXED]);
  say(!bothRefs.some((r) => r.field === 'status'),
    'a later migration redefining the function replaces the earlier one',
    `fields seen: ${[...new Set(bothRefs.map((r) => r.field))].join(', ')} — status is gone because 0050 came after 0048`);

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

  // src/ and scripts/ BOTH. Reported separately, because they mean different things: a bad column in
  // src/ is a broken screen, and one in scripts/ is a broken check — but a broken check is how a
  // broken screen goes unnoticed, and on 2026-09-25 nine gate steps failed on scripts/ alone while
  // this check called src/ clean and the conclusion drawn was far broader than that.
  const scan = (dir: string) => {
    const problems: Problem[] = [];
    let selects = 0; let writes = 0; let filters = 0; let star = 0; let dynamic = 0;
    for (const file of sourceFiles(dir)) {
      const at = file.replace(/\\/g, '/');
      // This file names dropped columns ON PURPOSE, in the self-test fixtures that prove the check
      // catches them. Scanning itself reports its own evidence as 8 defects.
      if (at.endsWith('scripts/column-exists-check.ts')) continue;
      const src = readFileSync(file, 'utf8');
      const found = findSites(src, at);
      star += found.star; dynamic += found.dynamic; selects += found.sites.length;
      for (const s of found.sites) checkSelect(s.table, s.select, columnsOf, { file: s.file, line: s.line }, problems);
      const fl = findFilters(src, at);
      dynamic += fl.dynamic; filters += fl.refs.length;
      for (const r of fl.refs) {
        // A qualified name is a filter on an EMBEDDED table, and belongs to that table.
        const dot = r.column.indexOf('.');
        const tbl = dot === -1 ? r.table : r.column.slice(0, dot);
        const col = dot === -1 ? r.column : r.column.slice(dot + 1);
        const cols = columnsOf(tbl);
        if (!cols) continue;                               // not a table: a relationship alias, unresolvable here
        if (!cols.has(col)) problems.push({ file: r.file, line: r.line, table: tbl, column: col, why: `"${tbl}" has no column "${col}" — a FILTER naming it fails the whole query` });
      }

      const w = findWrites(src, at);
      dynamic += w.dynamic; writes += w.sites.length;
      for (const s of w.sites) {
        const cols = columnsOf(s.table);
        if (!cols) { problems.push({ file: s.file, line: s.line, table: s.table, column: '(the table itself)', why: `no table called "${s.table}" is in the live schema` }); continue; }
        for (const k of s.keys) {
          if (!cols.has(k)) problems.push({ file: s.file, line: s.line, table: s.table, column: k, why: `"${s.table}" has no column "${k}" — a WRITE naming it fails outright` });
        }
      }
    }
    return { problems, selects, writes, filters, star, dynamic };
  };

  const app = scan('src');
  const probes = scan('scripts');
  const all = [...app.problems, ...probes.problems];

  console.log(`${Object.keys(defs).length} live tables`);
  console.log(`  src/      ${app.selects} literal select(s), ${app.writes} write payload(s)`);
  console.log(`  scripts/  ${probes.selects} literal select(s), ${probes.writes} write payload(s)`);
  console.log(`  not checked: ${app.star + probes.star} select('*') — names no column, and this is the shape that fails SILENTLY`);
  console.log(`  not checked: ${app.dynamic + probes.dynamic} built from a template literal or a variable — only known at run time`);

  // The trigger-record class, which no catalogue dependency reveals.
  const migs = sourceFiles('supabase/migrations', /\.sql$/).map((f) => ({ file: f.replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }));
  const refs = findTriggerFieldRefs(migs);
  const badRefs = refs.filter((r) => { const c = columnsOf(r.table); return c && !c.has(r.field); });
  console.log(`  trigger fields: ${refs.length} new./old. reference(s) across ${new Set(refs.map((r) => r.fn)).size} trigger function(s)`);
  for (const r of badRefs) {
    all.push({ file: r.file, line: 0, table: r.table, column: `new.${r.field}`, why: `${r.fn}() reads new.${r.field} but "${r.table}" has no such column — Postgres will NOT refuse the drop and will NOT warn; every insert fails at run time with 42703` });
  }

  if (all.length) {
    console.log('');
    for (const p of all) console.log(`  FAIL  ${p.file}${p.line ? ':' + p.line : ''} — ${p.why}`);
    console.log(`\n${all.length} named column(s) do not exist`);
    process.exitCode = 1;
    return;
  }
  console.log('\nevery literally-named column exists, in selects, in writes, and in trigger fields');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
