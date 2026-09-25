/**
 * Queue item 14 (4): flag every lead's source — broken, unreachable, landing page, paywall, sign-in.
 *
 *   npx tsx --env-file=.env.local scripts/source-flags-backfill.ts            # report
 *   npx tsx --env-file=.env.local scripts/source-flags-backfill.ts --write    # write (needs 0023)
 *
 * Each source is fetched again over plain HTTP only — free; a page that needs a browser reports as
 * unreachable rather than costing money. Writes the flag columns only: a lead's status is the
 * owner's to set, and this never touches it.
 */
import { createClient } from '@supabase/supabase-js';
import { fetchPage } from '../src/lib/fetch-page';
import { sourceFlag } from '../src/lib/source-quality';
import { hasSourceFlag } from '../src/lib/schema-features';
import { leadSource } from '../src/lib/lead-source';
import { LEAD_STATE_LEFT, withLeadState } from '../src/lib/workspace-state';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');

(async () => {
  const flagOn = await hasSourceFlag(db);
  if (WRITE && !flagOn) { console.error('leads.source_flag does not exist yet — apply migration 0023 first'); process.exit(1); }
  // 0049 dropped leads.status; it is read from the workspace's state row and flattened, so the
  // report line below still prints `l.status`.
  const { data: leadRows, error } = await db.from('leads').select(`id, source_url, companies(name), sources:lead_articles(articles(source_id)), ${LEAD_STATE_LEFT}`).eq('is_test', false).not('source_url', 'is', null);
  const leads = (leadRows ?? []).map(withLeadState);
  if (error) { console.error(error.message); process.exit(1); }
  const { data: paywalled } = await db.from('sources').select('id').eq('paywalled', true);
  const paywalledIds = new Set((paywalled ?? []).map((s: any) => s.id));

  const tally: Record<string, number> = {};
  const flagged: string[] = [];
  let i = 0;
  // Award notices are read from the TED API, not scraped, so their web page says nothing about the
  // source — and TED answers a burst of page requests with 429, which the first dry run reported
  // as 100 "unreachable" sources. They are left unflagged, and counted as not checked.
  const queue = [...(leads ?? [])].filter((l: any) => leadSource(l.source_url) === 'news');
  tally['not checked: award notice, read from the TED API'] = (leads ?? []).length - queue.length;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (i < queue.length) {
      const l: any = queue[i++];
      const url = String(l.source_url).split('#')[0];
      const page = await fetchPage(url, { allowBrowser: false });
      // A page that needs a browser was not tested here: that is not the same as unreachable. The
      // nightly recheck, which may use one, flags it for real.
      if (page.status !== 'live' && /bot\/JS wall|JavaScript-rendered|needs a browser/i.test(page.note ?? '')) {
        tally['not checked: needs a browser (the nightly recheck will)'] = (tally['not checked: needs a browser (the nightly recheck will)'] ?? 0) + 1;
        continue;
      }
      const sourcePaywalled = (l.sources ?? []).some((x: any) => paywalledIds.has(x.articles?.source_id));
      const r = sourceFlag(page, { requestedUrl: url, sourcePaywalled });
      tally[r.flag] = (tally[r.flag] ?? 0) + 1;
      if (r.flag !== 'ok') flagged.push(`  ${r.flag.padEnd(11)} ${(l.companies?.name ?? '').slice(0, 26).padEnd(26)} [${l.status}] ${url.slice(0, 80)}\n              ${r.why.slice(0, 160)}`);
      if (WRITE) await db.from('leads').update({ source_flag: r.flag, source_flag_why: r.why, source_flag_at: new Date().toISOString() }).eq('id', l.id);
    }
  }));
  console.log(`${WRITE ? 'WRITING' : 'dry run'} · 0023 applied: ${flagOn} · leads checked: ${queue.length}`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
  console.log(flagged.join('\n'));
})().catch((e) => { console.error(e); process.exit(1); });
