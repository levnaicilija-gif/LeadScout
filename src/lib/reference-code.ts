import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A new candidate's reference code (RFBT-<trade letter>-<number>) from 0001's next_reference_code — or an error, never null.
 *
 * Found 2026-09-15 in the release gate: Verify intake and the anonymiser read `.data` and ignored `.error`, so a call that
 * failed in transit created candidate "MARIAN M" with no reference code, the screen showed none, and the client version
 * crashed on `code.toLowerCase()` (enrich answered 500). The function itself cannot return null for a letter; only a
 * failed call can. Tried twice, a second apart; a failed first call may still have used up a number, which leaves a gap
 * in the sequence and nothing worse.
 */
export async function nextReferenceCode(db: SupabaseClient, tradeCode: string | null | undefined): Promise<string> {
  const tc = /^[A-Za-z]$/.test(String(tradeCode ?? '')) ? String(tradeCode).toUpperCase() : 'O';
  let problem = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { data, error } = await db.rpc('next_reference_code', { tc });
    if (!error && typeof data === 'string' && /^RFBT-[A-Z]-\d+$/.test(data)) return data;
    problem = error ? error.message : `it answered ${JSON.stringify(data)}`;
    if (attempt === 1) await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`the candidate's reference code could not be issued, so no candidate was created: ${problem}`);
}
