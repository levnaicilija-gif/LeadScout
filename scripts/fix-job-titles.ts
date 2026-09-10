/**
 * Repair titles already stored, with the same rule new ones now get.
 *
 * The fix in the crawl only applies to rows crawled after it. These were read before, and
 * Hiring now shows them: "Industrimekaniker / … Kymar Motion · Bergen", "Monteur Technische
 * Dienst Heteren Fulltime/Parttime 4.200 - 5.370", "Vacature".
 *
 * Order of preference: what the posting page calls itself, then the link text with the furniture
 * cut off, then nothing — and nothing means the row goes, because a posting whose role cannot be
 * read is not something a recruiter can act on.
 *
 *   npx tsx --env-file=.env.local scripts/fix-job-titles.ts           report only
 *   npx tsx --env-file=.env.local scripts/fix-job-titles.ts --write   apply
 */
import { createClient } from '@supabase/supabase-js';
import { cleanTitle, stripFurniture, needsPageTitle, titleFromPage } from '../src/lib/job-title';
import { httpGet } from '../src/lib/http';
import { countryFromJobLocation, isEuropean } from '../src/lib/geo';

const write = process.argv.includes('--write');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

(async () => {
  const { data } = await db.from('job_posts')
    .select('id, role, title, location, country, source_url, companies(name)')
    .eq('status', 'open');

  let fixed = 0; let dropped = 0; let unchanged = 0; let moved = 0;
  for (const p of (data ?? []) as any[]) {
    const co = p.companies?.name ?? null;
    const raw = p.role ?? p.title ?? '';
    let next: string | null = null;
    let how = '';

    if (needsPageTitle(raw, co)) {
      const page = await httpGet(p.source_url, {}, 15000);
      if (page.ok) { next = titleFromPage(page.body); how = 'from the posting page'; }
      if (!next) { next = cleanTitle(stripFurniture(raw, co)); how = 'furniture stripped'; }
    } else {
      // A title that needs nothing done to it is already correct. The first version of this
      // only set `next` when the text changed, so every good title fell through to the drop
      // branch — it would have deleted twenty-two of forty real postings.
      next = cleanTitle(stripFurniture(raw, co));
      how = next === raw ? 'unchanged' : 'furniture stripped';
    }

    // A title can name a place the location field never got. "Wind Site Technician II - Deming,
    // NM" is a New Mexico vacancy filed as Danish because the company is Danish.
    const fromTitle = countryFromJobLocation((next ?? raw).replace(/^.*?[-–—]\s*/, ''));
    const outside = fromTitle && !isEuropean(fromTitle);

    if (outside) {
      console.log(`  OUTSIDE EUROPE  ${fromTitle}  "${raw}"  [${co}]`);
      if (write) await db.from('job_posts').delete().eq('id', p.id);
      moved++;
      continue;
    }

    if (!next) {
      console.log(`  DROP    "${raw}"  [${co}] — no readable role`);
      if (write) await db.from('job_posts').delete().eq('id', p.id);
      dropped++;
      continue;
    }
    if (next === raw) { unchanged++; continue; }

    console.log(`  FIX     "${raw}"\n       -> "${next}"  (${how})`);
    if (write) await db.from('job_posts').update({ role: next, title: next }).eq('id', p.id);
    fixed++;
  }

  console.log(`\n${(data ?? []).length} open postings · ${fixed} retitled · ${dropped} dropped · ${moved} outside Europe · ${unchanged} already fine`);
  if (!write) console.log('(report only — pass --write to apply)');
})();
