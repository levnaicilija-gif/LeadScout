/**
 * Is the "auth transient" the auth service, the network, or us? Answers it with numbers.
 *
 *   npx tsx --env-file=.env.local scripts/auth-transient-probe.ts
 *
 * Creates one throwaway account, signs in, and asks getUser() across a range of idle gaps and then
 * under sustained concurrent load, wrapping the client's fetch to record the cause chain that
 * supabase-js discards. Removes the account afterwards; touches no product data.
 *
 * WHY. `AuthRetryableFetchError 0` took six of eleven gates on the night of 2026-09-19/20. That name
 * is only supabase-js's wrapper for "the fetch rejected", and its 0 is the absence of a status rather
 * than a status — which is what sent two earlier investigations towards auth and towards sockets.
 *
 * WHAT IT FOUND (2026-09-20): **12,947 calls, zero failures.** Idle gaps of 0 to 90 s all answered,
 * and 4, 12 and 30 concurrent workers for 20 s each answered — 1,169, 3,504 and 8,261 calls. It also
 * shows connection reuse working exactly as intended: about 73 ms on a reused socket against 100-270
 * ms once undici's 4 s keepAliveTimeout has expired and it opens a fresh one.
 *
 * So the fault is NOT Supabase, NOT the network, and NOT connection reuse. It belongs to `next start`
 * under load, which is what `fetch-spy.mjs` then caught: UND_ERR_CONNECT_TIMEOUT, a new TCP handshake
 * failing to complete inside undici's 10 s default. Run this first whenever the transient is blamed
 * again — a clean sweep here means the problem is in our process, not at the other end.
 */
import { createClient } from '@supabase/supabase-js';

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

/** Every fetch the auth client makes, with the real error when one rejects. */
type Attempt = { at: string; idleMs: number; ok: boolean; ms: number; err?: string };
const log: Attempt[] = [];
let idleForThisCall = 0;

const recordingFetch: typeof fetch = async (input, init) => {
  const started = Date.now();
  try {
    const res = await fetch(input as any, init as any);
    log.push({ at: new Date().toISOString(), idleMs: idleForThisCall, ok: true, ms: Date.now() - started });
    return res;
  } catch (e: any) {
    // The cause chain is the whole point: undici puts the socket-level reason in `cause`.
    const chain: string[] = [];
    for (let c: any = e; c; c = c.cause) chain.push(`${c.name ?? '?'}: ${c.message ?? c}${c.code ? ` (${c.code})` : ''}`);
    log.push({ at: new Date().toISOString(), idleMs: idleForThisCall, ok: false, ms: Date.now() - started, err: chain.join('  <- ') });
    throw e;
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Sweep first, clean up after. Any auth-probe account still on file is a previous run that did not
  // get to finish, and removing it here is the one cleanup that works however that run ended — no
  // signal, no `finally`, nothing this process has to be alive for.
  const { data: existing } = await admin.auth.admin.listUsers({ perPage: 200 });
  const stale = (existing?.users ?? []).filter((u) => /^auth-probe\+/.test(u.email ?? ''));
  for (const s of stale) {
    const { error } = await admin.auth.admin.deleteUser(s.id);
    console.log(error ? `left over from an earlier run, COULD NOT remove ${s.email}: ${error.message}` : `left over from an earlier run, removed ${s.email}`);
  }

  const stamp = Date.now();
  const email = `auth-probe+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data: made, error: mkErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (mkErr) throw new Error(`could not create the probe account: ${mkErr.message}`);
  const uid = made.user!.id;

  // This run takes about four minutes — 90 s of idle gaps, then three 20 s load phases — and anyone
  // who stops it early leaves an account behind, because a `finally` does not run when the process is
  // interrupted. It happened twice on 2026-09-20 to the person writing this, first with `timeout` and
  // then while testing the guard below, stranding two accounts in the real project until a hand sweep
  // found them — the same class of leftover CLAUDE.md already records twice.
  //
  // The handler covers Ctrl+C, and ON WINDOWS THAT IS ALL IT COVERS: `taskkill`, `pkill` and anything
  // else that ends the process outright never delivers a signal Node can run code for, which is why
  // the second account was stranded by the very test meant to prove the handler worked. The sweep at
  // the top is the real safety net, because it does not depend on this run ending politely at all.
  let cleanedUp = false;
  const sweep = async (why: string) => {
    if (cleanedUp) return;
    cleanedUp = true;
    const { error } = await admin.auth.admin.deleteUser(uid);
    console.log(error ? `\n${why}: COULD NOT remove ${email} — ${error.message}` : `\n${why}: throwaway account removed.`);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(sig, () => { void sweep(`stopped on ${sig}`).then(() => process.exit(130)); });
  }

  try {
    const sb = createClient(URL_, ANON, { auth: { persistSession: false }, global: { fetch: recordingFetch } });
    const { error: inErr } = await sb.auth.signInWithPassword({ email, password });
    if (inErr) throw new Error(`could not sign in: ${inErr.message}`);
    console.log('signed in; now asking getUser() across a range of idle gaps\n');

    // Gaps chosen around the places a pooled socket typically dies: undici's own keepAliveTimeout
    // (4 s by default), and the longer idles a gate leaves between probe steps.
    const GAPS = [0, 0, 0, 1_000, 3_000, 4_500, 6_000, 10_000, 20_000, 35_000, 60_000, 90_000];
    let failures = 0;
    for (const gap of GAPS) {
      if (gap) await sleep(gap);
      idleForThisCall = gap;
      const started = Date.now();
      const { data, error } = await sb.auth.getUser();
      const ms = Date.now() - started;
      const ok = !!data?.user && !error;
      if (!ok) failures++;
      console.log(`  idle ${String(gap).padStart(6)} ms -> ${ok ? 'ok ' : 'FAIL'} in ${String(ms).padStart(5)} ms${error ? `  ${error.name} ${(error as any).status ?? ''}` : ''}`);
    }

    console.log(`\n${failures} of ${GAPS.length} getUser() calls failed on idle alone`);

    // ---- phase 2: LOAD. Idle alone is handled — undici opens a fresh connection once its 4 s
    // keepAliveTimeout has expired, visible above as ~73 ms reused against ~100-270 ms fresh. The
    // hypothesis on file blames "a minute of the sweep's traffic", so this sustains parallel calls the
    // way a gate's probes do and watches for a socket written after the server has closed it.
    console.log('\n--- phase 2: sustained concurrent load ---');
    for (const workers of [4, 12, 30]) {
      const until = Date.now() + 20_000;
      let ok = 0, bad = 0;
      await Promise.all(Array.from({ length: workers }, async () => {
        while (Date.now() < until) {
          idleForThisCall = -1;
          const { data, error } = await sb.auth.getUser();
          if (data?.user && !error) ok++;
          else { bad++; console.log(`    FAIL ${error?.name ?? '?'} ${(error as any)?.status ?? ''}`); }
        }
      }));
      console.log(`  ${String(workers).padStart(3)} workers, 20 s: ${ok} ok, ${bad} failed`);
      failures += bad;
    }
    console.log(`\n${failures} failing getUser() calls in all`);
    const bad = log.filter((a) => !a.ok);
    console.log(`${bad.length} of ${log.length} underlying fetches rejected`);
    if (bad.length) {
      console.log('\nthe real errors, which supabase-js discards:');
      for (const b of bad) console.log(`  after ${b.idleMs} ms idle, ${b.ms} ms in: ${b.err}`);
    } else {
      console.log('\nno fetch rejected — the transient did not reproduce on idle alone.');
    }
  } finally {
    await sweep('done');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
