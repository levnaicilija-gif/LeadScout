/**
 * The tender chain's controls hold — no network, no database, no model:  npx tsx scripts/tender-chain-check.ts
 *
 * WHAT IT HOLDS, each with both arms:
 *   the KILL SWITCH reads OFF for anything but a readable row saying enabled = true (missing table, missing row,
 *     an error, enabled false) — and with it off, a run that names no company does NOTHING: no queue read,
 *     no lookup, no spend;
 *   the CLOCK is the database's — dbToday throws rather than guessing when db_utc_today cannot be read;
 *   the REGISTRATION NUMBER reaches the lookup prompt when the notice has one, and the prompt is byte-for-byte
 *     what it was when it does not, so no other caller changes;
 *   the GUARDS are still on the write path (read from the source, so removing one fails here): the shared-domain
 *     and directory refusal, the address check, the group-site rule, the never-overwrite write, the non-prospect
 *     skip, contact discovery, and the label the slice is counted by;
 *   the TICK knows the unit, asks whether it is due, dispatches it, and the route's allow-list carries it.
 */
import { readFileSync } from 'fs';
import { chainSwitch, dbToday, runTenderChain, skipReason, MAX_AWARD_AGE_DAYS, LABEL, SLICE_EUR } from '../src/lib/jobs/tender-chain';
import { AGE_UNKNOWN } from '../src/lib/discovery-order';
import { lookupPrompt } from '../src/lib/domain-lookup';

let failed = 0;
const check = (ok: boolean, what: string, got?: unknown) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` — ${JSON.stringify(got)}`}`); if (!ok) failed++; };

/** A database that answers `from(table)` with fixed rows and `rpc(name)` with a fixed answer, and records what was asked. */
function fakeDb(o: { tables?: Record<string, { data?: any; error?: any }>; rpc?: { data?: any; error?: any } }) {
  const asked: string[] = [];
  const builder = (table: string): any => {
    const res = o.tables?.[table] ?? { data: [], error: null };
    const b: any = new Proxy({}, {
      get: (_t, k) => {
        if (k === 'then') return (ok: any, no: any) => Promise.resolve({ data: res.data ?? [], error: res.error ?? null }).then(ok, no);
        if (k === 'maybeSingle' || k === 'single') return () => Promise.resolve({ data: Array.isArray(res.data) ? res.data[0] ?? null : res.data ?? null, error: res.error ?? null });
        return () => b;
      },
    });
    return b;
  };
  return { asked, from: (t: string) => { asked.push(t); return builder(t); }, rpc: (n: string) => { asked.push(`rpc:${n}`); return Promise.resolve({ data: o.rpc?.data ?? null, error: o.rpc?.error ?? null }); } } as any;
}

(async () => {
  console.log('--- the kill switch is OFF unless a readable row says on ---');
  check(!(await chainSwitch(fakeDb({ tables: { job_switches: { error: { message: "Could not find the table 'public.job_switches'" } } } }))).enabled, 'a missing table reads OFF');
  check(!(await chainSwitch(fakeDb({ tables: { job_switches: { data: [] } } }))).enabled, 'a missing row reads OFF');
  check(!(await chainSwitch(fakeDb({ tables: { job_switches: { data: [{ enabled: false }] } } }))).enabled, 'enabled = false reads OFF');
  check(!(await chainSwitch(fakeDb({ tables: { job_switches: { data: [{ enabled: 'true' }] } } }))).enabled, 'a truthy non-boolean reads OFF — only enabled === true is on');
  check((await chainSwitch(fakeDb({ tables: { job_switches: { data: [{ enabled: true, updated_at: 'x' }] } } }))).enabled, 'and enabled = true reads ON — the switch can be turned on at all');

  console.log('\n--- with the switch off, a run that names no company does nothing at all ---');
  const off = fakeDb({ rpc: { data: '2026-10-12' }, tables: { job_switches: { data: [{ enabled: false }] }, cost_log: { data: [] }, workspaces: { data: [] } } });
  // A run that gets PAST the switch reaches the queue and throws on this fake database — a NAMED failure here, not a
  // crash: the first version of this check only died with a stack trace when the switch was mutated away.
  let r: any = null; let past = '';
  try { r = await runTenderChain(off, { batch: 2, write: true }); } catch (e: any) { past = String(e?.message ?? e); }
  check(!past && r?.looked === 0 && r?.eur === 0 && /kill switch/.test(r?.stopped ?? ''), 'it stops at the switch, naming it', past ? `went PAST the switch: ${past}` : r?.stopped);
  check(!off.asked.includes('leads') && !off.asked.includes('companies'), 'and never reads the queue, let alone looks anything up', off.asked);

  console.log('\n--- "today" is the DATABASE\'s day, never this process\'s ---');
  check(await dbToday(fakeDb({ rpc: { data: '2026-10-12' } })) === '2026-10-12', 'db_utc_today is what the chain calls today');
  let threw = false;
  try { await dbToday(fakeDb({ rpc: { error: { message: 'function db_utc_today() does not exist' } } })); } catch { threw = true; }
  check(threw, 'and an unreadable clock THROWS rather than falling back to new Date()');
  // COMMENTS STRIPPED before any source assertion: the file's own doc comment quotes `.is('domain', null)`, so the
  // first version of the guard arm passed with the real guard deleted — a vacuous assertion, caught by its mutation.
  const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/.*$/gm, '$1');
  const src = code('src/lib/jobs/tender-chain.ts');
  check(!/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(src) && !/Budget\.open\(/.test(src), 'the chain never takes the day from this process (no new Date() day, no Budget.open)');

  console.log('\n--- the notice\'s registration number reaches the lookup, and nothing else changes ---');
  const a = { street: 'Lov Enghavevej 26', postalCode: '4700', city: 'Næstved', country: 'DNK' };
  const withReg = lookupPrompt({ name: 'HOLBØLL A/S', country: 'DK', address: a, registrationId: '18296675' });
  const without = lookupPrompt({ name: 'HOLBØLL A/S', country: 'DK', address: a });
  check(/Company registration number \(from the contract award notice\): 18296675/.test(withReg), 'the CVR is sent when the notice has one', withReg);
  check(without === 'Company: HOLBØLL A/S\nRegistered address (from the contract award notice): Lov Enghavevej 26, 4700 Næstved, DNK\nCountry: DK', 'and without one the prompt is exactly what it was', without);
  check(lookupPrompt({ name: 'X', registrationId: '   ' }) === 'Company: X', 'a blank number sends nothing');

  console.log('\n--- too old to buy, and held for the owner: skipped, NEVER "no website" (owner, 2026-10-12) ---');
  const q = (o: Partial<{ id: string; name: string; age: number; lookedToday: boolean }>) => skipReason({ id: 'x', name: 'Acme Stahlbau GmbH', age: 10, lookedToday: false, ...o });
  check(MAX_AWARD_AGE_DAYS === 365, `the limit is item 17's stale line for awards, 365 days — read ${MAX_AWARD_AGE_DAYS}`);
  check(/^skipped: too old/.test(q({ age: 366 }) ?? ''), 'an award 366 days old is skipped as TOO OLD', q({ age: 366 }));
  check(/^skipped: too old/.test(q({ age: 2327 }) ?? ''), 'and the 2020 Czech framework awards (2,327 days) are too', q({ age: 2327 }));
  check(q({ age: 365 }) === null, 'while one exactly 365 days old is still looked up', q({ age: 365 }));
  check(q({ age: AGE_UNKNOWN }) === null, 'and an UNDATED award is not "too old" — unknown is not old', q({ age: AGE_UNKNOWN }));
  check(!/no website|no_domain_found/i.test(q({ age: 9999 }) ?? ''), 'a too-old skip never reads as "no website" — it is reopened by changing the limit, not by undoing a status');
  // THE PLAIN RULE (owner, 2026-10-12): held when a name has NO company form AND NO trade word.
  check(/^held:/.test(q({ name: 'Aleš Kozel', age: 10 }) ?? ''), 'a bare person\'s name, fresh, is HELD for the owner');
  check(/^held:/.test(q({ name: 'Ing. Martin Barteček', age: 10 }) ?? ''), 'and so is one with a title in front');
  check(q({ name: 'Bassenberg Gerüstbau', age: 19 }) === null, 'Bassenberg Gerüstbau is NOT held — "Gerüstbau" is a trade word (the owner released it: it is a firm)');
  check(q({ name: '„Zakład Usług Wiertniczych STUDWIERT Kurkowski Piotr”', age: 24 }) === null, 'STUDWIERT stays in the queue — it carries a person\'s name inside a firm\'s');
  for (const n of ['HOLBØLL A/S', 'Parat Halvorsen As', 'Johann Rohrer GmbH', 'BRODOGRADILIŠTE PUNAT, d. o. o.', 'Linjemontage i Grästorp Aktiebolag', 'Atzwanger AG-SpA', 'ASTILLEROS DE CARTAGENA, S.L.', 'DUNAGÉP Szolgáltató Zártkörűen Működő Részvénytársaság', 'ЕКОВАТ - БЪЛГАРИЯ ЕООД'])
    check(q({ name: n, age: 10 }) === null, `a company form or trade word is not held — "${n}"`);
  check(/^skipped: too old/.test(q({ name: 'Aleš Kozel', age: 2327 }) ?? ''), 'a person\'s name on a TOO-OLD award reports "too old" (owner: the eight Czech sole traders stay skipped as too old)');
  check(/already looked up today/.test(q({ lookedToday: true }) ?? ''), 'and one looked up today waits for a later day');
  check(q({}) === null, 'while an ordinary fresh winner is in the queue');

  console.log('\n--- every guard is still on the write path ---');
  const guards: [RegExp, string][] = [
    [/mayStoreDomain\(/, 'the shared-domain and directory refusal (mayStoreDomain)'],
    [/addressCheck\(/, 'the address check'],
    [/siteScope\(/, 'the group-site rule (siteScope)'],
    [/\.is\('domain', null\)/, 'a domain stored elsewhere is never overwritten'],
    [/nonProspect\(/, 'non-prospects (trade bodies, banks, academia…) are skipped with their reason'],
    [/discoverAtCompany\(/, 'contact discovery on a stored domain'],
    [/lookedToday/, 'one lookup per company per database day'],
    [/registrationId/, 'the registration number is passed to the lookup'],
    [/label: `\$\{LABEL\} · /, `every lookup is labelled "${LABEL} · …", which is what the slice is counted by`],
  ];
  for (const [re, what] of guards) check(re.test(src), what);
  check(SLICE_EUR === 1, `the slice is €1.00 (owner's decision), read €${SLICE_EUR}`);
  const lookupSrc = code('src/lib/domain-lookup.ts');
  check(/`resolve \$\{ctx\.label/.test(lookupSrc) && /`web search · \$\{ctx\.label/.test(lookupSrc), "lookupDomain's cost_log details carry the label, so the slice's LIKE matches both rows");

  console.log('\n--- the tick runs it, between radar and discovery ---');
  const tick = code('src/lib/jobs/tick.ts');
  check(/'tender-chain'/.test(tick.match(/export type TickUnit[^;]*/)?.[0] ?? ''), "the tick knows a 'tender-chain' unit");
  check(/\['tender-chain',\s*\(\)\s*=>\s*tenderChainDue/.test(tick), 'it asks whether the chain is due');
  // Anchored on the due-list entries themselves ("['unit', () =>"): BATCH['tender-chain'] also contains the bare
  // "['tender-chain'" and appears much earlier, which made the first version of this assertion fail on correct code.
  const at = (u: string) => tick.search(new RegExp(`\\['${u}',\\s*\\(\\)\\s*=>`));
  check(at('radar') >= 0 && at('radar') < at('tender-chain') && at('tender-chain') < at('discovery'), 'after radar (which ingests the winners) and before discovery (which takes the new domains)', [at('radar'), at('tender-chain'), at('discovery')]);
  check(/chainSwitch\(db\)/.test(tick.match(/async function tenderChainDue[\s\S]*?\n}/)?.[0] ?? ''), 'and the due-check reads the kill switch first');
  check(/runTenderChainBatch\(req\)/.test(tick), 'it dispatches the batch');
  check(/'tender-chain'/.test(code('src/app/api/jobs/tick/route.ts').match(/const UNITS[^;]*/)?.[0] ?? ''), "and the route's UNITS allow-list carries it, or ?unit=tender-chain would run everything");

  console.log(failed ? `\n${failed} failed` : '\ntender chain: all checks passed');
  process.exitCode = failed ? 1 : 0;
})();
