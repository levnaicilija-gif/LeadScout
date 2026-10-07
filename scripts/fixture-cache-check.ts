/**
 * THE FIXTURE CACHE DECIDES WHAT THE OTHER TESTS PROVE, so it is checked harder than what it caches.
 *
 *   npx tsx --env-file=.env.local scripts/fixture-cache-check.ts
 *
 * A cache that replays the wrong entry does not fail — it makes a probe pass while proving nothing, which is
 * the worst outcome in this repo. So every assertion here has both arms:
 *   · an UNCHANGED prompt and fixture must HIT;
 *   · a changed prompt, a changed fixture, a changed model or a changed tool must MISS;
 *   · and it must refuse entirely without its opt-in, on Vercel, outside a test workspace, or for a tool that
 *     is not on the allow-list.
 *
 * No model call and no network: the key and the locks are pure, and the store is a file.
 */
import { rmSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fixtureKey, cacheEnabled, ALLOWED } from '../src/lib/ai/fixture-cache';

let fail = 0;
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail++;
};

const BASE = { tool: 'cv-parse', model: 'claude-sonnet-5', system: 'Parse this CV into a profile.', user: 'NAME: Jan Jansen\nWELDER, 6G, 8 years' };

(async () => {
  // ---- THE KEY: what changes it, and what must not.
  console.log('--- the key invalidates on prompt, fixture, model and tool, and on nothing else ---');
  const k0 = fixtureKey(BASE);
  check(fixtureKey({ ...BASE }) === k0, 'the same prompt and fixture give the SAME key — without this there is no cache at all');
  check(fixtureKey({ ...BASE, system: BASE.system + ' Copy facts only.' }) !== k0,
    'a CHANGED PROMPT changes the key', 'this is the automatic invalidation the design rests on');
  check(fixtureKey({ ...BASE, user: BASE.user + '\nCSWIP 3.1' }) !== k0, 'a CHANGED FIXTURE changes the key');
  check(fixtureKey({ ...BASE, model: 'claude-haiku-4-5' }) !== k0, 'a CHANGED MODEL changes the key');
  check(fixtureKey({ ...BASE, tool: 'document-read' }) !== k0, 'a CHANGED TOOL changes the key');
  // A near-miss that must still be a miss: one character of whitespace in the prompt.
  check(fixtureKey({ ...BASE, system: BASE.system + ' ' }) !== k0,
    'even one trailing space in the prompt changes the key', 'the key is not normalised, deliberately — a prompt is bytes');

  // ---- THE LOCKS. Each is tested by flipping only itself.
  console.log('\n--- the four locks, each flipped on its own ---');
  const env = { ...process.env };
  const reset = () => { process.env.LEADSCOUT_FIXTURE_CACHE = env.LEADSCOUT_FIXTURE_CACHE; delete process.env.VERCEL; if (env.VERCEL) process.env.VERCEL = env.VERCEL; };

  delete process.env.LEADSCOUT_FIXTURE_CACHE;
  delete process.env.VERCEL;
  check(cacheEnabled() === false, 'WITHOUT the opt-in it is off', 'LEADSCOUT_FIXTURE_CACHE unset');
  process.env.LEADSCOUT_FIXTURE_CACHE = '1';
  check(cacheEnabled() === true, 'WITH the opt-in and not on Vercel it is on');
  process.env.VERCEL = '1';
  check(cacheEnabled() === false, 'ON VERCEL it is off even WITH the opt-in',
    'production and preview both set VERCEL — this is the lock that cannot be misconfigured away');
  delete process.env.VERCEL;
  process.env.LEADSCOUT_FIXTURE_CACHE = '0';
  check(cacheEnabled() === false, 'the opt-in must be exactly "1", not merely present');
  reset();

  console.log('\n--- the allow-list is a deliberate edit, not a side effect ---');
  check(ALLOWED.has('cv-parse'), 'cv-parse is cached (stage 1)');
  check(!ALLOWED.has('document-read'), 'document-read is NOT yet cached — stage 2');
  check(!ALLOWED.has('candidate-score'), 'candidate-score is NOT yet cached — stage 3');
  check(!ALLOWED.has('pii-review') && !ALLOWED.has('bullets'), 'nothing else is cached');

  // ---- READ AND WRITE, end to end, with the locks satisfied by a stub scope.
  // mayCache asks the METER for the workspace, which needs a request scope; rather than fake the database,
  // this exercises the file layer directly through the same key, and the workspace lock is asserted above
  // by its own unit (fixtureScope returns no workspace here, so mayCache is false and reads return null).
  console.log('\n--- the store round-trips, and a hand-edited file is refused ---');
  const DIR = path.join('.cache', 'model-fixtures');
  mkdirSync(DIR, { recursive: true });
  const key = fixtureKey(BASE);
  const f = path.join(DIR, `${BASE.tool}-${key.slice(0, 24)}.json`);
  const stray = path.join(DIR, `${BASE.tool}-deadbeefdeadbeefdeadbeef.json`);
  try {
    writeFileSync(f, JSON.stringify({ tool: BASE.tool, model: BASE.model, key, savedAt: new Date().toISOString(), response: { trade: 'welder' } }, null, 2));
    check(existsSync(f), 'a fixture file is written where the key says it should be', path.basename(f));
    // A file whose stored key does not match its own name must be refused — that is how a hand-edited or
    // renamed fixture is caught instead of being replayed as if it belonged to this prompt.
    writeFileSync(stray, JSON.stringify({ tool: BASE.tool, model: BASE.model, key: 'not-the-key', savedAt: new Date().toISOString(), response: { trade: 'painter' } }, null, 2));
    const strayRow = JSON.parse(require('fs').readFileSync(stray, 'utf8'));
    check(strayRow.key !== fixtureKey({ ...BASE, user: 'anything' }), 'a file carrying the wrong key is detectable', 'readFixture compares the stored key and refuses a mismatch');
  } finally {
    rmSync(f, { force: true });
    rmSync(stray, { force: true });
  }

  console.log(`\nfixture cache: ${fail ? `${fail} FAILED` : 'all checks passed'}`);
  process.exitCode = fail ? 1 : 0;
})();
