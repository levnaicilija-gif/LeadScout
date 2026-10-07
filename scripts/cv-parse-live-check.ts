/**
 * THE LIVE CHECK FOR cv-parse — the thing that stops the fixture cache from quietly retiring a real test.
 *
 *   LEADSCOUT_TEST_RUN=cv-parse-live-check npx tsx --env-file=.env.local scripts/cv-parse-live-check.ts
 *   add --force to run live regardless of the schedule.
 *
 * A replayed probe proves the PRODUCT still handles a profile; it proves nothing about the model, the prompt or
 * the key. So one real call is made WHENEVER THE PROMPT CHANGES and otherwise at least weekly, and the cache is
 * explicitly switched off for it. Everything else replays.
 *
 * THE PROMPT IS HASHED FROM `parseCv.toString()`, not from a copy of the text. The template literal lives
 * inside that function, so the hash moves exactly when the prompt moves and there is no second copy to drift —
 * the mistake TITLE_SYSTEM made by holding a hand-typed list of trades. It also changes if the surrounding
 * logic changes, which is the cautious direction: it runs live more often, never less.
 *
 * Its own spend is marked test traffic through LEADSCOUT_TEST_RUN, so it never counts against the daily cap.
 */
import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { parseCv } from '../src/lib/ai/documents';

const DIR = path.join('.cache', 'model-fixtures');
const STATE = path.join(DIR, 'live-cv-parse.json');
const WEEK_MS = 7 * 86400000;
const force = process.argv.includes('--force');

/** A CV short enough to be cheap and complete enough that a real parse must find a trade. */
const FIXTURE = [
  'CURRICULUM VITAE',
  'Name: Jan Pietersen',
  'Nationality: Dutch (NL)',
  'Trade: Industrial painter and blaster, 11 years',
  'Certificates: FROSIO Level III, GWO Basic Safety Training',
  'Languages: Dutch (native), English (fluent)',
  '2022-2025  Surface treatment of modules at a shipyard, Rotterdam. Blasting to Sa 2.5, two-coat epoxy.',
  '2018-2022  Maintenance painting on an offshore platform, Dutch North Sea. Rotation 2:2.',
  'Available: immediately',
].join('\n');

let fail = 0;
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail++;
};

type State = { promptHash: string; lastRunISO: string; model?: string };

(async () => {
  const promptHash = crypto.createHash('sha256').update(parseCv.toString()).digest('hex').slice(0, 16);
  let state: State | null = null;
  if (existsSync(STATE)) {
    try { state = JSON.parse(readFileSync(STATE, 'utf8')) as State; } catch { state = null; }
  }

  const ageMs = state ? Date.now() - Date.parse(state.lastRunISO) : Infinity;
  const promptChanged = !state || state.promptHash !== promptHash;
  const overdue = ageMs > WEEK_MS;
  const why = force ? 'forced with --force'
    : !state ? 'no live run has ever been recorded'
      : promptChanged ? `THE PROMPT CHANGED (was ${state.promptHash}, now ${promptHash})`
        : overdue ? `the last live run was ${Math.floor(ageMs / 86400000)} days ago` : '';

  console.log(`cv-parse prompt hash: ${promptHash}`);
  if (state) console.log(`last live run: ${state.lastRunISO} (${Math.floor(ageMs / 86400000)} days ago), prompt then ${state.promptHash}`);

  if (!why) {
    const dueIn = Math.ceil((WEEK_MS - ageMs) / 86400000);
    console.log(`SKIPPED — the prompt is unchanged and the last live run was within the week. Next live run due in ${dueIn} day(s).`);
    console.log('cv-parse live: not due (this is a pass, and no model call was made)');
    return;
  }

  console.log(`RUNNING LIVE — ${why}`);
  // THE CACHE IS OFF FOR THIS CALL. Without this the check would replay the very fixture it exists to verify.
  const had = process.env.LEADSCOUT_FIXTURE_CACHE;
  process.env.LEADSCOUT_FIXTURE_CACHE = '0';
  try {
    const profile = await parseCv(FIXTURE);
    check(!!profile, 'the live call returned a profile');
    check(typeof profile?.trade === 'string' && profile.trade.length > 2, 'it names a trade', String(profile?.trade));
    check(typeof profile?.trade_code === 'string' && profile.trade_code.length >= 1, 'and a trade_code', String(profile?.trade_code));
    // The fixture says painter and blaster; a live parse that finds neither is a real signal, not a flake.
    const t = `${profile?.trade ?? ''} ${(profile?.trades ?? []).join(' ')}`.toLowerCase();
    check(/paint|blast/.test(t), 'and the trade it names matches the fixture', t.slice(0, 60));
    check(Array.isArray(profile?.certificates_claimed) && profile.certificates_claimed.length > 0,
      'and it read the certificates', JSON.stringify(profile?.certificates_claimed ?? []).slice(0, 70));
  } catch (e: any) {
    fail++;
    console.log(`  FAIL  the live call threw — ${String(e?.status ?? '')} ${String(e?.message ?? e).slice(0, 140)}`);
  } finally {
    if (had === undefined) delete process.env.LEADSCOUT_FIXTURE_CACHE; else process.env.LEADSCOUT_FIXTURE_CACHE = had;
  }

  if (!fail) {
    // The schedule only advances on a PASS. A failed live check must stay due, or one bad day would buy a
    // week of silence from the only thing checking the model.
    try {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(STATE, JSON.stringify({ promptHash, lastRunISO: new Date().toISOString(), model: 'claude-sonnet-5' } satisfies State, null, 2));
      console.log('  recorded: the next live run is due in 7 days, or sooner if the prompt changes');
    } catch (e: any) {
      console.log(`  NOTE: the schedule could not be recorded (${String(e?.message ?? e).slice(0, 80)}) — the next run will go live again`);
    }
  }

  console.log(`\ncv-parse live: ${fail ? `${fail} FAILED` : 'all checks passed'}`);
  process.exitCode = fail ? 1 : 0;
})();
