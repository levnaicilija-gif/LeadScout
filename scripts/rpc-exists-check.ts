/**
 * Every database FUNCTION this codebase calls, and every STORAGE BUCKET it names, exists in the live project.
 *
 *   npx tsx --env-file=.env.local scripts/rpc-exists-check.ts
 *   npx tsx --env-file=.env.local scripts/rpc-exists-check.ts --self-test
 *
 * WHY THIS EXISTS. `column-exists-check` covers every table and literally-named column, in selects, writes,
 * filters and trigger fields. It cannot see a function or a bucket, because neither is a column — so a
 * `.rpc()` naming something no migration created, or an upload to a bucket nobody made, reaches production
 * unguarded. Found by audit on 2026-09-27, with current exposure zero: all five functions and all three
 * buckets exist today. It is built anyway, because this exact failure class has ALREADY happened here.
 *
 * THE 0037 PRECEDENT, which is the whole argument. 0037's `delete_candidate_rows` answered from the day it
 * was applied while ITS TABLE NEVER EXISTED: `deletion_log` returned PGRST205 to the service role as well
 * as to the app's own key, and nobody knew until the owner queried it by hand. A function existing tells
 * you nothing about what it touches — and nothing was watching whether the function existed either.
 *
 * WHAT IT PROTECTS, stated because it is why this was worth doing at zero exposure:
 *   next_reference_code         every Verify intake — a candidate with no reference code (already happened)
 *   delete_candidate_rows       a senior's permanent deletion, which must not half-run
 *   rls_tables_without_policy   the nightly RLS sweep and Home's "Data access check" pill — the mechanism
 *                               this project trusts as proof that isolation holds
 *
 * IT DOES NOT INVOKE ANYTHING, and that is not squeamishness. `next_reference_code` is
 * `select 'RFBT-' || … || nextval('candidate_ref_seq')` (0001:89), so CALLING it to see whether it exists
 * consumes a reference code and puts a permanent gap in candidate numbering — once per gate run, for ever.
 * `delete_candidate_rows` deletes. So existence is read from PostgREST's own OpenAPI document at
 * `GET /rest/v1/`, which lists every exposed function as an `/rpc/<name>` path and costs one read.
 *
 * THE NAMES COME FROM THE SOURCE, NEVER FROM A LIST HERE. `scripts/migrations-status.ts` is the cautionary
 * example: it probes per-migration artifacts from a hand-kept list, is not in the gate, and probes ZERO of
 * the five functions this codebase actually calls. A list maintained by hand covers what someone remembered
 * to add. Scanning `.rpc('…')` covers a function the moment somebody calls it.
 *
 * WHAT IT CANNOT DO, said here rather than discovered later:
 *   - a DYNAMIC name — `db.rpc(name, arg)` — is unknowable until run time. It is COUNTED and reported, never
 *     silently passed, exactly as column-exists-check counts its stars and template literals.
 *   - it checks EXISTENCE, not signatures. A function whose parameter was renamed still exists and would
 *     pass here while failing at run time. The OpenAPI document does carry parameter names, so that is a
 *     real possible extension rather than an impossibility — it is simply not what this asserts today.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

type Site = { file: string; line: number; name: string };

/* ------------------------------------------------------------------ reading the source */

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

/** Every `.rpc('name'` and every `storage.from('bucket'`, plus a count of the ones built at run time. */
export function findCalls(src: string, file: string): { rpc: Site[]; buckets: Site[]; dynamic: number } {
  const rpc: Site[] = [];
  const buckets: Site[] = [];
  let dynamic = 0;
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    // A literal name: .rpc('foo'  /  .rpc("foo"
    for (const m of line.matchAll(/\.rpc\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)) {
      rpc.push({ file, line: i + 1, name: m[1] });
    }
    // A variable name: .rpc(name  — knowable only at run time, so counted rather than judged.
    for (const m of line.matchAll(/\.rpc\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[,)]/g)) {
      if (!/^['"]/.test(m[1])) dynamic++;
    }
    for (const m of line.matchAll(/storage\s*\.\s*from\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      buckets.push({ file, line: i + 1, name: m[1] });
    }
  });
  return { rpc, buckets, dynamic };
}

/* ------------------------------------------------------------------ what the project really has */

/** Every function PostgREST exposes, read from its OpenAPI document. No function is invoked. */
async function liveFunctions(): Promise<Set<string>> {
  const res = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`the OpenAPI document could not be read: ${res.status} ${res.statusText}`);
  const spec: any = await res.json();
  const paths = Object.keys(spec?.paths ?? {});
  // A spec with no /rpc/ paths at all means the read succeeded and told us nothing — refuse it rather than
  // report every function missing, which is the blind-instrument failure this project keeps paying for.
  const fns = paths.filter((p) => p.startsWith('/rpc/')).map((p) => p.slice(5));
  if (!fns.length) throw new Error(`the OpenAPI document lists no functions at all (${paths.length} paths) — refusing to call every function missing on that basis`);
  return new Set(fns);
}

async function liveBuckets(): Promise<Set<string>> {
  const res = await fetch(`${url}/storage/v1/bucket`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`the bucket list could not be read: ${res.status} ${res.statusText}`);
  const list: any = await res.json();
  if (!Array.isArray(list)) throw new Error('the bucket list was not an array');
  return new Set(list.map((b: any) => b.name));
}

/* ------------------------------------------------------------------ the self-test */

function selfTest(): number {
  let bad = 0;
  const say = (ok: boolean, what: string, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
    if (!ok) bad++;
  };
  console.log('--- the checker, pointed at things that do and do not exist ---');

  const f = findCalls(`
    const a = await db.rpc('next_reference_code', { tc });
    const b = await db.rpc('no_such_function_at_all');
    const c = await db.rpc(name, arg);
    const d = await db.storage.from('documents').upload(p, x);
    const e = await db.storage.from('no_such_bucket').upload(p, x);
  `, 'self-test');
  say(f.rpc.length === 2 && f.rpc.map((r) => r.name).join(',') === 'next_reference_code,no_such_function_at_all',
    'both literal rpc names are found', JSON.stringify(f.rpc.map((r) => r.name)));
  say(f.dynamic === 1, 'a DYNAMIC rpc name is counted, not silently passed', `dynamic ${f.dynamic}`);
  say(f.buckets.length === 2, 'both bucket names are found', JSON.stringify(f.buckets.map((b) => b.name)));

  // The arm that matters: a missing name must be REPORTED, and a real one must NOT be.
  const fns = new Set(['next_reference_code']);
  const missing = f.rpc.filter((r) => !fns.has(r.name)).map((r) => r.name);
  say(missing.length === 1 && missing[0] === 'no_such_function_at_all',
    'a function that is not live is reported, and the live one is not', JSON.stringify(missing));
  const bks = new Set(['documents']);
  const missingB = f.buckets.filter((b) => !bks.has(b.name)).map((b) => b.name);
  say(missingB.length === 1 && missingB[0] === 'no_such_bucket',
    'a bucket that is not live is reported, and the live one is not', JSON.stringify(missingB));

  // And the guard against the instrument itself being blind: an empty function list must REFUSE, not pass.
  say(f.rpc.filter((r) => !new Set<string>().has(r.name)).length === 2,
    'with an EMPTY live list every name is missing — which is why liveFunctions() refuses a spec with no /rpc/ paths',
    'the refusal lives in liveFunctions, asserted by reading it rather than by faking a 200');

  console.log(bad ? `\nself-test: ${bad} FAILED` : '\nself-test: all checks passed');
  return bad;
}

/* ------------------------------------------------------------------ main */

(async () => {
  if (process.argv.includes('--self-test')) { process.exitCode = selfTest() ? 1 : 0; return; }
  if (!url || !key) { console.error('URL and SERVICE_ROLE_KEY are required'); process.exitCode = 1; return; }

  const [fns, bks] = await Promise.all([liveFunctions(), liveBuckets()]);
  const problems: string[] = [];
  let rpcSites = 0; let bucketSites = 0; let dynamic = 0;
  const seenFn = new Set<string>(); const seenBk = new Set<string>();

  for (const dir of ['src', 'scripts']) {
    for (const file of sourceFiles(dir)) {
      const at = file.replace(/\\/g, '/');
      // This file names a function and a bucket that do not exist ON PURPOSE, in its self-test fixtures.
      if (at.endsWith('scripts/rpc-exists-check.ts')) continue;
      const found = findCalls(readFileSync(file, 'utf8'), at);
      dynamic += found.dynamic;
      rpcSites += found.rpc.length;
      bucketSites += found.buckets.length;
      for (const r of found.rpc) {
        seenFn.add(r.name);
        if (!fns.has(r.name)) problems.push(`${r.file}:${r.line} calls rpc("${r.name}") — no such function is exposed by the live project`);
      }
      for (const b of found.buckets) {
        seenBk.add(b.name);
        if (!bks.has(b.name)) problems.push(`${b.file}:${b.line} uses storage bucket "${b.name}" — no such bucket exists`);
      }
    }
  }

  console.log(`${fns.size} function(s) exposed live · ${bks.size} bucket(s) live`);
  console.log(`  ${rpcSites} rpc call site(s) naming ${seenFn.size} distinct function(s): ${[...seenFn].sort().join(', ')}`);
  console.log(`  ${bucketSites} storage site(s) naming ${seenBk.size} bucket(s): ${[...seenBk].sort().join(', ')}`);
  // Counted, never hidden — the same honesty column-exists-check applies to select('*').
  console.log(`  not checked: ${dynamic} rpc name(s) built at run time — only knowable when called`);

  if (problems.length) {
    console.log('');
    for (const p of problems) console.log(`FAIL  ${p}`);
    console.log(`\n${problems.length} missing artifact(s)`);
    process.exitCode = 1;
    return;
  }
  console.log('\nevery function called and every bucket named exists in the live project');
})().catch((e) => { console.error(`rpc-exists-check could not run: ${e?.message ?? e}`); process.exitCode = 1; });
