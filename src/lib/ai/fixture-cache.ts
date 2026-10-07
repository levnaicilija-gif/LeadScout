import crypto from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import path from 'path';
import { fixtureScope } from './meter';

/**
 * REPLAY A PROBE'S MODEL CALL INSTEAD OF PAYING FOR IT AGAIN — test workspaces only, never production.
 *
 * Measured 2026-10-07: test traffic was 61% of thirty days of model spend ($77.69 of $127.55), and the three
 * largest kinds were all probes re-deriving the SAME answer from the SAME fixtures on every run — cv-parse
 * $19.65, document-read $11.47, candidate-score $10.25. A full gate is 44 calls and about $0.58, and the gate
 * ran 247 times in those thirty days. Nothing about that spend was buying new information after the first run.
 *
 * THE KEY IS THE WHOLE DESIGN. It is a hash of the SYSTEM PROMPT, the USER CONTENT and the MODEL, so the cache
 * invalidates by construction rather than by anyone remembering to clear it: change the prompt and the key
 * changes; change the fixture CV and the key changes; switch model and the key changes. There is no manual
 * "bust the cache" step to forget. A stale entry is simply never read again.
 *
 * FOUR LOCKS KEEP IT OUT OF PRODUCTION, and they are independent on purpose:
 *   1. an explicit opt-in, LEADSCOUT_FIXTURE_CACHE=1, set only by release-gate.sh;
 *   2. a refusal when VERCEL is set — production and preview both set it, so the deployed app can never read
 *      or write this cache whatever else is misconfigured;
 *   3. the workspace in scope must be marked is_test, read through the meter's own scope; when that cannot be
 *      determined the answer is NO;
 *   4. only the tools on ALLOWED may be cached, so widening it is a deliberate edit and not a side effect.
 *
 * AND IT ANNOUNCES ITSELF. Every replay appends to a run log and prints a line, because a replayed run that
 * looks identical to a live one is worse than no cache at all: it would quietly stop proving the model works.
 * `scripts/fixture-replays.ts` prints the count as its own gate step, and the live checks
 * (`scripts/cv-parse-live-check.ts`) run the real call on a schedule and whenever the prompt changes.
 */

/** Stage 1 is cv-parse alone. document-read and candidate-score follow once the saving is measured. */
export const ALLOWED = new Set<string>(['cv-parse']);

const DIR = path.join('.cache', 'model-fixtures');
const RUN_LOG = path.join(DIR, 'replayed.log');

/** Locks 1 and 2 — cheap, synchronous, and true or false regardless of any database. */
export function cacheEnabled(): boolean {
  if (process.env.LEADSCOUT_FIXTURE_CACHE !== '1') return false;
  // VERCEL is set on production AND preview. A cache that could run there is not a cache, it is a bug.
  if (process.env.VERCEL) return false;
  return true;
}

/** The cache key: prompt + input + model. Nothing else, so nothing else can make two runs disagree. */
export function fixtureKey(input: { tool: string; model: string; system: string; user: string }): string {
  return crypto.createHash('sha256')
    .update(input.tool).update('\u0000')
    .update(input.model).update('\u0000')
    .update(input.system).update('\u0000')
    .update(input.user)
    .digest('hex');
}

const fileFor = (tool: string, key: string) => path.join(DIR, `${tool}-${key.slice(0, 24)}.json`);

export type Fixture = { tool: string; model: string; key: string; savedAt: string; response: unknown };

/** Locks 3 and 4, plus the allow-list. Async because the test-workspace answer comes from the database. */
export async function mayCache(tool: string | null): Promise<boolean> {
  if (!cacheEnabled()) return false;
  if (!tool || !ALLOWED.has(tool)) return false;
  return fixtureScope().isTest();
}

let replays = 0;
export const replayCount = () => replays;

/** The cached response, or null. Reading is never allowed to throw into a model call. */
export async function readFixture(input: { tool: string; model: string; system: string; user: string }): Promise<{ response: unknown } | null> {
  if (!(await mayCache(input.tool))) return null;
  const key = fixtureKey(input);
  const f = fileFor(input.tool, key);
  if (!existsSync(f)) return null;
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as Fixture;
    if (parsed.key !== key) return null;                      // a renamed or hand-edited file is not trusted
    replays++;
    const line = `${new Date().toISOString()} REPLAYED ${input.tool} ${key.slice(0, 12)}`;
    console.log(`[fixture-cache] ${line} — no model call was made`);
    try { mkdirSync(DIR, { recursive: true }); appendFileSync(RUN_LOG, line + '\n'); } catch { /* the log is a convenience */ }
    return { response: parsed.response };
  } catch {
    return null;                                              // unreadable or malformed: fall through to a live call
  }
}

/** Store the first real response. Failure to store is never allowed to fail the call that produced it. */
export async function writeFixture(input: { tool: string; model: string; system: string; user: string }, response: unknown): Promise<void> {
  if (!(await mayCache(input.tool))) return;
  const key = fixtureKey(input);
  const row: Fixture = { tool: input.tool, model: input.model, key, savedAt: new Date().toISOString(), response };
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(fileFor(input.tool, key), JSON.stringify(row, null, 2));
    console.log(`[fixture-cache] STORED ${input.tool} ${key.slice(0, 12)} — the next run replays it`);
  } catch { /* a cache that cannot write is only a slower cache */ }
}
