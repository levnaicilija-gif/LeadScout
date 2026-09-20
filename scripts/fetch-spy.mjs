/**
 * See the error supabase-js throws away, from inside the running server.
 *
 *   NODE_OPTIONS="--import ./scripts/fetch-spy.mjs" node node_modules/next/dist/bin/next start -p 3104
 *   ... then drive load at it: scripts/rls-sweep.ts, then a probe against that port.
 *
 * Patches globalThis.fetch BEFORE Next patches its own, so Next wraps this one and every outbound
 * request the app really makes passes through here on its way to undici. Touches no product code and
 * is never imported by the app — it exists only to be preloaded.
 *
 * WHY. supabase-js turns any fetch rejection into `AuthRetryableFetchError 0` and discards the
 * original, so the gate log could only ever say "the sign-in service could not be reached". This
 * prints the whole cause chain, which on 2026-09-20 read:
 *
 *   TypeError: fetch failed  <-  ConnectTimeoutError: Connect Timeout Error
 *   (attempted addresses: 172.64.149.246:443, 104.18.38.10:443, timeout: 10000ms) [UND_ERR_CONNECT_TIMEOUT]
 *
 * — undici unable to complete a NEW TCP handshake to Supabase's Cloudflare addresses inside its 10 s
 * default, under an rls-sweep-plus-probe load. /rest/v1/verifications and /rest/v1/job_posts rejected
 * the same way, so this was never auth-specific: auth is only the visible one, because requireUser
 * raises an error boundary while a failed data read degrades quietly.
 *
 * TWO THINGS THAT WILL BITE WHOEVER RUNS IT NEXT. Everything goes to STDERR on purpose: node loads
 * this into npx/npm's own process too, and anything on stdout there is parsed as npm output and
 * breaks the launch with a module-not-found naming your own log line. And invoke next directly
 * (`node node_modules/next/dist/bin/next`) rather than through npx, for the same reason.
 */
const realFetch = globalThis.fetch;
const say = (s) => process.stderr.write(`${s}\n`);
let seq = 0;

globalThis.fetch = async function spyFetch(input, init) {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  const isAuth = /\/auth\/v1\//.test(url);
  const n = ++seq;
  const started = Date.now();
  try {
    const res = await realFetch(input, init);
    if (isAuth) {
      const ms = Date.now() - started;
      if (ms > 1000) say(`[fetch-spy] #${n} SLOW ${ms}ms ${res.status} ${url.replace(/\?.*/, '')}`);
    }
    return res;
  } catch (e) {
    const chain = [];
    for (let c = e; c; c = c.cause) {
      chain.push(`${c.name ?? '?'}: ${c.message ?? c}${c.code ? ` [${c.code}]` : ''}`);
      if (chain.length > 6) break;
    }
    say(`[fetch-spy] #${n} REJECTED after ${Date.now() - started}ms  ${url.replace(/\?.*/, '')}`);
    say(`[fetch-spy]    cause chain: ${chain.join('  <- ')}`);
    for (const sub of (e?.cause?.errors ?? []).slice(0, 4)) {
      say(`[fetch-spy]    aggregate: ${sub?.name}: ${sub?.message}${sub?.code ? ` [${sub.code}]` : ''}`);
    }
    throw e;
  }
};

say('[fetch-spy] installed');
