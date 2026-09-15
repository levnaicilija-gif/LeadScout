/**
 * Switchboards stored cut short — fewer than 9 digits — re-read from the page they came from. Report only without --write.
 *
 *   npx tsx --env-file=.env.local scripts/repair-short-switchboards.ts [--write]
 *
 * Found 2026-09-15: phoneOn stopped at an en dash or a slash inside a printed number, so Kattner Stahlbau was stored as
 * "+49 (0)3435" (the page prints "+49 (0)3435 – 666 2-0") and Daldrup & Söhne as "+49 (0) 25 93". Each short value's
 * own source page is fetched again and read with the fixed phoneOn. The stored value is replaced only when the full
 * number read there begins with the same digits — the same number, whole. Anything else clears the switchboard and its
 * source: a fragment is never left for a recruiter to dial, and a different number is never swapped in unexamined.
 */
import { createClient } from '@supabase/supabase-js';
import { fetchPage } from '../src/lib/fetch-page';
import { phoneOn } from '../src/lib/hiring-contacts';

const write = process.argv.includes('--write');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const digits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

(async () => {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('companies').select('id, name, switchboard, switchboard_source_url').not('switchboard', 'is', null).order('id').range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const short = rows.filter((c) => digits(c.switchboard).length < 9);
  console.log(`switchboards stored: ${rows.length} · cut short (under 9 digits): ${short.length}`);
  let bad = 0;
  for (const c of short) {
    const page = c.switchboard_source_url ? await fetchPage(c.switchboard_source_url) : null;
    const full = page && page.status === 'live' ? phoneOn(page) : null;
    const same = !!full && digits(full).startsWith(digits(c.switchboard));
    const patch = same ? { switchboard: full } : { switchboard: null, switchboard_source_url: null };
    console.log(`  ${c.name}: stored "${c.switchboard}" · page ${page ? page.status : 'no source'} · read now ${full ? `"${full}"` : 'nothing'} → ${same ? `replace with "${full}"` : 'clear (not the same number whole)'}`);
    if (!write) continue;
    const { error } = await db.from('companies').update(patch).eq('id', c.id);
    if (error) { bad++; console.log(`    FAILED: ${error.message}`); }
  }
  console.log(write ? `written · problems ${bad}` : '\nreport only — add --write to apply');
  process.exitCode = bad ? 1 : 0;
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
