/**
 * Is there enough free memory for the gate's BROWSER steps? Run immediately before the first one.
 *
 *   npx tsx scripts/memory-preflight.ts [minGB]
 *
 * WHY IT SITS HERE AND NOT AT THE TOP OF THE GATE. The floor was read once, before `next build`, and treated
 * as the figure that mattered. It is not: the build front-loads its own memory and the gate then opens
 * several Chromium contexts sixty-odd steps later, by which point the headroom measured at the start is gone.
 * Measured on 2026-09-28 — a gate begun at a verified 6.06–6.20 GB free ended with 5.6 GB free and NO node or
 * Chromium processes left, so roughly half a gigabyte never came back.
 *
 * THE THREE DATA POINTS that set the threshold, all on the same machine and the same build:
 *
 *   5.86 GB at start  ->  FAILED  smoke, page.goto timeout on /app/radar at 390px
 *   6.06 GB at start  ->  FAILED  today and smoke, page.goto timeouts
 *   6.05 GB at start  ->  passed  81 of 81
 *
 * So 6 GB is not a threshold, it is the middle of the noise, and the earlier CLAUDE.md entry saying "treat
 * anything under 6 GB as a refusal" was set too low. 6.5 GB is the refusal line here, checked at the moment
 * it matters rather than 25 minutes earlier.
 *
 * AND THEN A FOURTH RUN AT 7.03 GB FAILED THE SAME WAY, so read this threshold for what it is:
 *
 *   7.03 GB at start ->  FAILED  smoke, page.goto timeout on /app/today — and free RAM was 7.15 GB AFTER
 *                                the run, higher than at the start, with today and design-shots both passing
 *
 * MEMORY IS THEREFORE NOT THE CAUSE OF THESE TIMEOUTS, and this check does not claim to prevent them. All
 * four failures share load rather than memory: every one happened inside a FULL gate and every one passed in
 * isolation against the identical build. The honest claim is the weak one — below ~6.5 GB a timeout is more
 * likely, and above it one is not prevented. CLAUDE.md carries the stalled-read HYPOTHESIS and the measurement
 * (item 31) that would test it; nothing here should be read as a diagnosis.
 *
 * WHAT IT BUYS, WHICH IS STILL WORTH THE TWO SECONDS: a gate that stops with a sentence naming memory,
 * instead of running for twenty-five minutes and then failing with `page.goto: Timeout 60000ms exceeded` —
 * an error that looks exactly like a broken page and sent this session hunting a product defect twice. A
 * killed or starved gate also keeps creating throwaway accounts, which is how two probe workspaces were
 * stranded earlier tonight. It buys a fast, unambiguous refusal and a likelier-to-pass gate, not a green one.
 *
 * It reads os.freemem(), which on Windows reports available physical memory — the same figure as
 * Win32_OperatingSystem.FreePhysicalMemory, and the one both failures were measured against.
 */
import os from 'node:os';

const GB = 1024 ** 3;
const MIN_GB = Number(process.argv[2] ?? 6.5);

// Sampled rather than read once: the figure moves by a few hundred megabytes between reads, which is how a
// single lucky sample let a gate start at what looked like 6.2 GB. The LOWEST sample decides.
const samples: number[] = [];
for (let i = 0; i < 3; i++) {
  samples.push(os.freemem() / GB);
  // A short synchronous pause; this runs once per gate and does not need to be elegant.
  const until = Date.now() + 700;
  while (Date.now() < until) { /* wait */ }
}
const low = Math.min(...samples);
const total = os.totalmem() / GB;

console.log(`free physical memory: ${samples.map((s) => s.toFixed(2)).join(' / ')} GB of ${total.toFixed(2)} GB total`);
console.log(`lowest sample ${low.toFixed(2)} GB · the browser steps need at least ${MIN_GB.toFixed(2)} GB`);

if (low < MIN_GB) {
  console.error('');
  console.error(`MEMORY TOO LOW FOR THE BROWSER STEPS: ${low.toFixed(2)} GB free, ${MIN_GB.toFixed(2)} GB needed.`);
  console.error('Stopping here rather than timing out 25 minutes in. The gate opens several Chromium contexts');
  console.error('from verify-e2e onwards, and below this line they are likelier to fail with "page.goto:');
  console.error('Timeout 60000ms exceeded" — which reads exactly like a broken page and is not one. Measured:');
  console.error('5.86 GB failed, 6.06 GB failed, 6.05 GB passed, so 6 GB is inside the noise rather than above');
  console.error('it. Clearing memory makes that timeout LESS LIKELY and does not rule it out: a run at 7.03 GB');
  console.error('failed the same way, so above this line a timeout means "under load, cause not established".');
  console.error('Close what is holding memory (msedgewebview2 and msedge were the largest holders here) and');
  console.error('re-run. Everything before this point has already passed and will pass again.');
  process.exitCode = 1;
} else {
  console.log('enough for the browser steps.');
}
