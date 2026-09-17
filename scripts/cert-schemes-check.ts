/**
 * How many certificate schemes are searched automatically — pinned, so the number on screen is a
 * counted property and never an inference.
 *
 * Pure — no database, no model, no network. In the release gate.
 *
 * WHY THIS EXISTS. "8 of 16 schemes automatic" was carried for a whole session and was never
 * measured: 8 is `Object.keys(ADAPTERS).length`, and four of those adapters exist precisely to
 * explain that they CANNOT search — IRATA and CISRS behind captchas, WINDA behind a login, and
 * Denmark authorising companies rather than electricians. Counting them as automatic inverts the
 * owner's own rule.
 *
 * Then a second count got it wrong the other way. `closed.ts` builds its adapters through a factory
 * that keeps `why` and `instead` in a closure and never puts them on the object, so testing for
 * `why` found 8 searchable and 0 manual. Capability was not readable from the adapter at all.
 *
 * So each adapter now DECLARES it, and this check holds the totals. A new adapter that forgets the
 * field fails typecheck; one that claims wrongly fails here.
 *
 *   npx tsx scripts/cert-schemes-check.ts
 */
import { CERT_TABLE } from '../src/lib/certs/tables';
import { ADAPTERS, ISSUER_EMAIL_BODIES, SEARCHABLE_BODIES, searchableCount } from '../src/lib/verify/adapters';

let failed = 0;
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

/* ------------------------------------------------------------------ the denominator */
const bodies = [...new Set(CERT_TABLE.map((e) => e.body))].sort();
check(bodies.length === 16, 'the library decodes 16 distinct schemes', `${bodies.length}: ${bodies.join(', ')}`);
check(CERT_TABLE.length > bodies.length,
  'CERT_TABLE has more entries than schemes — one row per scheme AND level, which is what made 27 look like a scheme count',
  `${CERT_TABLE.length} entries, ${bodies.length} bodies`);

/* -------------------------------------------------------------------- the numerator */
const searchable = Object.values(ADAPTERS).filter((a) => a.searchable).map((a) => a.body).sort();
const manual = Object.values(ADAPTERS).filter((a) => !a.searchable).map((a) => a.body).sort();

check(searchable.length === 4, 'four schemes are searched automatically', searchable.join(', '));
check(searchable.join(',') === 'ampp,cswip,frosio,pcn',
  'and they are the four with a public register and no captcha or login', searchable.join(', '));
check(manual.length === 4, 'four adapters exist only to say why they cannot search', manual.join(', '));
check(manual.join(',') === 'cisrs,electrical_dk,irata,winda',
  'and they are the captcha, login and company-only registers', manual.join(', '));

check(searchableCount() === 4, 'searchableCount() agrees — the card reads a counted property, not a literal', String(searchableCount()));
check(SEARCHABLE_BODIES.size === 4 && [...SEARCHABLE_BODIES].sort().join(',') === searchable.join(','),
  'SEARCHABLE_BODIES matches what the adapters declare');

/* --------------------------------------------------------- iso9606 is neither of those */
check(ISSUER_EMAIL_BODIES.has('iso9606'), 'ISO 9606 is checked by asking the issuer, not by searching a register');
check(!searchable.includes('iso9606'), 'so it is not counted as searched automatically');
check(!ADAPTERS.iso9606, 'and it has no adapter at all — there is no register to point one at');

/* -------------------------------------------------- every adapter declares its capability */
for (const [key, a] of Object.entries(ADAPTERS)) {
  check(typeof a.searchable === 'boolean', `${key} declares whether it can search`, String(a.searchable));
  check(a.body === key, `${key} is keyed by its own body`, a.body);
}

/* ------------------------------------------- the sentence the card is allowed to say */
const claim = `${searchableCount()} of ${bodies.length} searched automatically`;
check(claim === '4 of 16 searched automatically', 'the card can say exactly this', claim);
check(!/8 of 16/.test(claim), 'and never "8 of 16", which counted four adapters that cannot search');

console.log(failed ? `\ncert-schemes check: ${failed} FAILED` : '\ncert-schemes check: all checks passed');
process.exit(failed ? 1 : 0);
