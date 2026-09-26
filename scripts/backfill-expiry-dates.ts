/**
 * Re-read every stored verification expiry from the text actually printed on its document.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-expiry-dates.ts            # report only
 *   npx tsx --env-file=.env.local scripts/backfill-expiry-dates.ts --write    # store the corrections
 *
 * `verifications.valid_until` is a Postgres `date` and the lookup route used to hand it `ext.expiry`,
 * the string copied off the document, leaving Postgres to parse it in MDY. Unambiguous forms survived
 * and ambiguous ones flipped in silence: "17 Jan 2028" stored correctly, "03.09.2028" — 3 September on
 * a European ISO 9606 welding qualification — stored as 2028-03-09, six months early. The route is
 * fixed; this repairs what it already wrote.
 *
 * Three outcomes per row, and the middle one is the point:
 *   agrees      the stored date is what the printed text says. Untouched.
 *   CORRECTED   the stored date disagrees with the printed text. Rewritten.
 *   CLEARED     the printed text does not force one reading (05/06/2028 is 5 June to a British issuer
 *               and 6 May to an American one). The stored date was a guess, so it goes; the printed
 *               text stays in documents.extracted.expiry for a recruiter to confirm.
 *
 * A row whose date came from a REGISTER rather than the printed page is left alone: the adapter
 * returned a real date and the document's printed text is not authoritative over it. Those are
 * identified by result — a register answer is 'valid' or 'invalid', never 'not_supported'/'pending'.
 */
import { createClient } from '@supabase/supabase-js';
import { printedDate } from '../src/lib/printed-date';
import { probeAdmin } from '../src/lib/test-data';

const admin = probeAdmin();
const write = process.argv.includes('--write');

(async () => {
  const { data: vs, error } = await admin.from('verifications').select('id, document_id, result, method, valid_until');
  if (error) { console.log(`verifications could not be read: ${error.message}`); process.exit(1); }
  const { data: docs, error: dErr } = await admin.from('documents').select('id, type, extracted');
  if (dErr) { console.log(`documents could not be read: ${dErr.message}`); process.exit(1); }
  const byId = new Map((docs ?? []).map((d: any) => [d.id, d]));

  const tally = { agrees: 0, corrected: 0, cleared: 0, fromRegister: 0, noPrinted: 0, failed: 0 };
  console.log(`${vs?.length ?? 0} verification(s)${write ? '' : ' — REPORT ONLY, pass --write to store'}\n`);

  for (const v of (vs ?? []) as any[]) {
    const doc: any = byId.get(v.document_id);
    const printed = doc?.extracted?.expiry ?? null;
    const stored = v.valid_until ?? null;

    // A register's own answer outranks the printed page.
    if (v.result === 'valid' || v.result === 'invalid') {
      tally.fromRegister++;
      console.log(`  register answer, left alone   stored=${stored ?? '—'}  (result=${v.result})`);
      continue;
    }
    if (!printed) {
      tally.noPrinted++;
      console.log(`  nothing printed, left alone   stored=${stored ?? '—'}`);
      continue;
    }

    const read = printedDate(printed);
    const want = read.date;
    if (want === stored) { tally.agrees++; console.log(`  agrees    "${String(printed).padEnd(14)}" -> ${stored ?? 'null'}`); continue; }

    const kind = want === null ? 'CLEARED  ' : 'CORRECTED';
    console.log(`  ${kind} "${String(printed).padEnd(14)}" stored ${String(stored ?? 'null').padEnd(11)} -> ${want ?? 'null'}   ${read.why}`);
    if (want === null) tally.cleared++; else tally.corrected++;

    if (!write) continue;
    const { error: wErr } = await admin.from('verifications').update({ valid_until: want }).eq('id', v.id);
    if (wErr) { tally.failed++; console.log(`      NOT STORED: ${wErr.message}`); continue; }
    const { data: back } = await admin.from('verifications').select('valid_until').eq('id', v.id).single();
    const ok = ((back as any)?.valid_until ?? null) === want;
    if (!ok) { tally.failed++; console.log(`      WROTE BUT READ BACK ${(back as any)?.valid_until ?? 'null'} — expected ${want ?? 'null'}`); }
    else console.log(`      stored, and read back ${want ?? 'null'}`);
  }

  console.log(`\nagrees ${tally.agrees}, corrected ${tally.corrected}, cleared ${tally.cleared}, register answers left alone ${tally.fromRegister}, nothing printed ${tally.noPrinted}${tally.failed ? `, FAILED ${tally.failed}` : ''}`);
  // exitCode, not process.exit(): calling exit() here tears the supabase client's handles down
  // mid-flight and Windows answers with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"
  // and exit 127 — a crash reported as a failure by a script that had just succeeded.
  process.exitCode = tally.failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
