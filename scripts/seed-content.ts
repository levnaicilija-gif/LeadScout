/**
 * Load the shipped trade cards and glossary.
 *
 * These rows carry workspace_id null, which is what "shipped with the product" means: every
 * workspace reads them, and a workspace's own edits are separate rows that shadow them. Running
 * this again updates the shipped copy and never touches anything a senior has written.
 *
 *   npx tsx --env-file=.env.local scripts/seed-content.ts
 */
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), 'seeds', f), 'utf8'));

(async () => {
  const probe = await db.from('trade_cards').select('id').limit(1);
  if (probe.error) {
    console.error(`trade_cards is not there yet — apply 0018 first (${probe.error.message})`);
    process.exit(1);
  }

  const cards = read('trade-cards.json') as any[];
  let cardsDone = 0;
  for (const c of cards) {
    const { error } = await db.from('trade_cards').upsert({
      workspace_id: null,
      trade: c.trade,
      lang: 'en',
      title: c.title,
      what_it_is: c.what_it_is,
      certificates: c.certificates ?? [],
      codes: c.codes ?? [],
      check_on_cv: c.check_on_cv ?? [],
      red_flags: c.red_flags ?? [],
      // Rates and rotations ship EMPTY on purpose. They are commercial facts that change by
      // country and by month, and a number invented here would be quoted to a client as ours.
      rates: [],
      rotations: [],
      questions: c.questions ?? [],
      updated_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,trade,lang' });
    if (error) console.error(`  ${c.trade}: ${error.message}`);
    else cardsDone++;
  }

  const terms = read('glossary.json') as any[];
  let termsDone = 0;
  for (const t of terms) {
    const { error } = await db.from('glossary').upsert({
      workspace_id: null,
      term: t.term,
      lang: 'en',
      category: t.category ?? null,
      short: t.short,
      long: t.long ?? null,
      see_also: t.see_also ?? [],
      updated_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,term,lang' });
    if (error) console.error(`  ${t.term}: ${error.message}`);
    else termsDone++;
  }

  console.log(`${cardsDone}/${cards.length} trade cards · ${termsDone}/${terms.length} glossary terms`);
  console.log('rates and rotations left unset on every card — a senior fills them in Settings');
})();
