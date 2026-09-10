/**
 * Undo the seed's confusion between competitors and agencies.
 *
 * seeds/agencies.csv is a list of firms RFBT competes with for people — which includes EPC
 * contractors who employ trades directly. Those are customers, not agencies. Their own "focus"
 * text in the CSV says which they are, so it decides, and nothing is guessed at from the name.
 */
import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';

const write = process.argv.includes('--write');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const RECRUITMENT = /recruit|staffing|manpower|personnel|crewing|crew management|resourcing|workforce|talent|secondment|detacher|uitzend|bemanning|temporary|contract(or)? (staff|labour|personnel)|global mobility|payroll/i;
const EMPLOYER = /\bepc\b|contractor|engineering|fabrication|industrial services|maintenance|shipyard|yard|marine construction|dredging|insulation|surface protection|project services|installation/i;

(async () => {
  const rows = parse(fs.readFileSync('seeds/agencies.csv'), { columns: true, skip_empty_lines: true }) as any[];
  const misfiled: { name: string; focus: string }[] = [];
  for (const r of rows) {
    const focus = `${r.focus ?? ''} ${r.keywords ?? ''}`;
    // Only a firm whose own description is about supplying people is an agency.
    if (!RECRUITMENT.test(focus) && EMPLOYER.test(focus)) misfiled.push({ name: r.company, focus: String(r.focus ?? '').slice(0, 70) });
  }
  console.log(`${rows.length} rows in seeds/agencies.csv · ${misfiled.length} describe an employer, not an agency\n`);
  for (const m of misfiled) console.log(`  ${m.name.padEnd(24)} ${m.focus}`);

  if (!write) { console.log('\n(dry run — pass --write to correct them)'); return; }

  let fixed = 0;
  for (const m of misfiled) {
    const { data, error } = await db.from('companies')
      .update({ employer_type: 'epc_contractor' })
      .eq('employer_type', 'staffing_agency').ilike('name', m.name).select('id, name');
    if (error) { console.log(`  could not update ${m.name}: ${error.message}`); continue; }
    fixed += (data ?? []).length;
  }
  console.log(`\ncorrected ${fixed} company rows`);
})();
