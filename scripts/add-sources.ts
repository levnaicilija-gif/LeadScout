/**
 * Add the named sources, and promote the ones already in the list.
 *
 * Nothing is added on the strength of a guessed URL. Each candidate is fetched, and kept only
 * when it answers and articleLinks() finds something article-shaped on it — a source that 404s
 * is worse than a missing source, because the morning crawl reports it as quiet rather than
 * broken.
 *
 *   npx tsx --env-file=.env.local scripts/add-sources.ts           probe and report
 *   npx tsx --env-file=.env.local scripts/add-sources.ts --write   add and promote
 */
import { createClient } from '@supabase/supabase-js';
import { fetchPage, articleLinks } from '../src/lib/fetch-page';

const write = process.argv.includes('--write');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

/** Candidates, most likely address first. The first that answers with articles wins. */
const CANDIDATES: { name: string; type: 'news' | 'tender' | 'job_board'; region?: string; urls: string[] }[] = [
  { name: 'Danske Maritime', type: 'news', region: 'DK', urls: ['https://danskemaritime.dk/nyheder/', 'https://danskemaritime.dk/en/news/', 'https://danskemaritime.dk/'] },
  { name: 'Norsk Industri', type: 'news', region: 'NO', urls: ['https://www.norskindustri.no/dette-jobber-vi-med/nyheter/', 'https://www.norskindustri.no/nyheter/', 'https://www.norskindustri.no/'] },
  { name: 'Damen Shipyards', type: 'news', region: 'NL', urls: ['https://www.damen.com/about/news', 'https://www.damen.com/news', 'https://www.damen.com/'] },
  { name: 'Meyer Werft', type: 'news', region: 'DE', urls: ['https://www.meyerwerft.com/en/press/press_releases/index.jsp', 'https://www.meyerwerft.com/de/presse/pressemitteilungen/', 'https://www.meyerwerft.com/en/press/', 'https://www.meyerwerft.com/en/'] },
  { name: 'Fincantieri', type: 'news', region: 'IT', urls: ['https://www.fincantieri.com/en/media/press-releases/', 'https://www.fincantieri.com/en/media/news/', 'https://www.fincantieri.com/'] },
  { name: 'Maritime Danmark', type: 'news', region: 'DK', urls: ['https://maritimedanmark.dk/nyheder', 'https://maritimedanmark.dk/seneste-nyt', 'https://www.maritimedanmark.dk/', 'https://maritimedanmark.dk/'] },
  { name: 'Skipsrevyen', type: 'news', region: 'NO', urls: ['https://www.skipsrevyen.no/nyheter', 'https://skipsrevyen.no/', 'https://www.skipsrevyen.no/artikler', 'https://www.skipsrevyen.no/'] },
  { name: 'Schiff & Hafen', type: 'news', region: 'DE', urls: ['https://www.schiffundhafen.de/news/', 'https://www.schiffundhafen.de/'] },
  { name: 'Energy Voice', type: 'news', region: 'GB', urls: ['https://www.energyvoice.com/category/oilandgas/', 'https://www.energyvoice.com/'] },
  { name: 'E24', type: 'news', region: 'NO', urls: ['https://e24.no/energi-og-klima', 'https://e24.no/naeringsliv', 'https://e24.no/'] },
  { name: 'Offshore Norge', type: 'news', region: 'NO', urls: ['https://www.offshorenorge.no/aktuelt/nyheter/', 'https://www.offshorenorge.no/en/news/', 'https://www.offshorenorge.no/'] },
  { name: 'Bilfinger', type: 'company_press' as any, region: 'DE', urls: ['https://www.bilfinger.com/en/media/news/', 'https://www.bilfinger.com/en/media/press-releases/', 'https://www.bilfinger.com/'] },
  { name: 'KAEFER', type: 'company_press' as any, region: 'DE', urls: ['https://www.kaefer.com/en/newsroom/', 'https://www.kaefer.com/en/media/news/', 'https://www.kaefer.com/en/press/', 'https://www.kaefer.com/en/'] },
  { name: 'Muehlhan', type: 'company_press' as any, region: 'DE', urls: ['https://muehlhan.com/en/news/', 'https://www.muehlhan.com/en/newsroom/', 'https://www.muehlhan.com/en/media/', 'https://muehlhan.com/'] },
  { name: 'Aibel', type: 'company_press' as any, region: 'NO', urls: ['https://aibel.com/news', 'https://aibel.com/en/news', 'https://aibel.com/'] },
  { name: 'Find a Tender', type: 'tender', region: 'GB', urls: ['https://www.find-tender.service.gov.uk/Search/Results?&noticeType=contract_award', 'https://www.find-tender.service.gov.uk/Search/Results', 'https://www.find-tender.service.gov.uk/'] },
];

/** Already in the list, and belonging in the daily crawl. */
const PROMOTE = [
  'doffin.no', 'udbud.dk', 'tenderned.nl', 'ted.europa.eu',
  'shipbuilding', 'shipyard', 'maritime', 'skipsrevyen', 'offshore-energy',
  'upstreamonline', 'offshore-mag', 'oedigital', 'rivieramm', 'motorship',
  'aker', 'saipem', 'subsea7', 'mcdermott', 'petrofac', 'boskalis', 'deme',
  'technipenergies', 'woodgroup', 'worley', 'fluor', 'bilfinger', 'kaefer',
];

(async () => {
  const { data: ws } = await db.from('workspaces').select('id').order('created_at').limit(1).maybeSingle();
  const { data: existing } = await db.from('sources').select('id, name, url, type, tier, enabled, relevance');
  const have = new Set((existing ?? []).map((s: any) => String(s.url).replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').toLowerCase()));

  console.log('--- probing the missing sources ---');
  const add: any[] = [];
  for (const c of CANDIDATES) {
    let chosen: { url: string; links: number; via: string } | null = null;
    for (const url of c.urls) {
      const key = url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').toLowerCase();
      if (have.has(key)) { chosen = { url, links: -1, via: 'already in the list' }; break; }
      const page = await fetchPage(url);
      if (page.status !== 'live') continue;
      const links = articleLinks(page, 15).length;
      if (links >= 3) { chosen = { url, links, via: page.via }; break; }
      if (!chosen) chosen = { url, links, via: page.via };          // readable but thin; keep looking
    }
    if (!chosen || chosen.links === 0) { console.log(`  SKIP  ${c.name} — nothing article-shaped on any candidate URL`); continue; }
    if (chosen.links === -1) { console.log(`  have  ${c.name} — ${chosen.url}`); continue; }
    console.log(`  ADD   ${c.name.padEnd(20)} ${chosen.links} links via ${chosen.via}  ${chosen.url}`);
    add.push({ workspace_id: ws?.id, name: c.name, url: chosen.url, type: c.type, region: c.region, enabled: true, tier: 'priority', relevance: 80, tier_reason: 'named by the recruiter as a source that matters', classified_at: new Date().toISOString() });
  }

  const promote = (existing ?? []).filter((s: any) =>
    s.tier !== 'priority'
    && s.type !== 'job_board'
    && s.tier !== 'off'
    && PROMOTE.some((p) => `${s.name ?? ''} ${s.url}`.toLowerCase().includes(p)));
  console.log(`\n--- promoting ${promote.length} existing sources to priority ---`);
  promote.slice(0, 40).forEach((s: any) => console.log(`  ${(s.tier ?? '—').padEnd(9)} ${s.url}`));
  if (promote.length > 40) console.log(`  … and ${promote.length - 40} more`);

  if (!write) { console.log('\n(report only — pass --write to apply)'); return; }

  if (add.length) {
    const { error } = await db.from('sources').upsert(add, { onConflict: 'workspace_id,url' });
    console.log(error ? `\ncould not add: ${error.message}` : `\nadded ${add.length}`);
  }
  for (const s of promote) {
    await db.from('sources').update({ tier: 'priority', enabled: true, relevance: Math.max(70, s.relevance ?? 70), tier_reason: 'promoted: shipbuilding, Nordic oil & gas, EPC/fabrication or an award feed' }).eq('id', s.id);
  }
  console.log(`promoted ${promote.length}`);
})();
