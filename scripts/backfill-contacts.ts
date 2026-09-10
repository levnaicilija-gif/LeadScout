/**
 * Leads created before migration 0004 lost their contacts: the upsert had no unique index to
 * conflict on, so every insert failed and the error was swallowed. The article text is still
 * stored, so the people can be recovered without re-fetching anything.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-contacts.ts          report only
 *   npx tsx --env-file=.env.local scripts/backfill-contacts.ts --write  write the contacts
 */
import { createClient } from '@supabase/supabase-js';
import { extractLead } from '../src/lib/ai/radar-extract';
import { linkedinSearchUrl, googleSearchUrl } from '../src/lib/search-urls';

const write = process.argv.includes('--write');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

(async () => {
  const { data: leads } = await db
    .from('leads')
    .select('id, workspace_id, company_id, project_name, source_url, companies(name)')
    .eq('kind', 'won_work');

  const gaps: any[] = [];
  for (const l of leads ?? []) {
    const { count } = await db.from('contacts').select('id', { count: 'exact', head: true }).eq('lead_id', l.id);
    if (!count) gaps.push(l);
  }
  console.log(`${gaps.length} of ${(leads ?? []).length} won-work leads have no named person\n`);

  for (const l of gaps) {
    const company = (l as any).companies?.name ?? '(unknown company)';
    // The article the lead came from, by way of lead_articles or the source url.
    const { data: link } = await db.from('lead_articles').select('article_id').eq('lead_id', l.id).limit(1).maybeSingle();
    let article: any = null;
    if (link) ({ data: article } = await db.from('articles').select('id, url, text').eq('id', link.article_id).maybeSingle());
    if (!article && l.source_url) ({ data: article } = await db.from('articles').select('id, url, text').eq('url', l.source_url).maybeSingle());

    if (!article?.text) { console.log(`${company} — no stored article text, cannot recover (${l.source_url})`); continue; }

    const res = await extractLead(article.text, article.url);
    if (!res.ok) { console.log(`${company} — re-read gives no lead: ${res.why}`); continue; }
    if (!res.lead.people.length) { console.log(`${company} — the article genuinely names nobody`); continue; }

    console.log(`${company} — ${res.lead.people.map((p: any) => `${p.name} (${p.title})`).join(', ')}`);
    if (!write) continue;

    for (const p of res.lead.people) {
      const { error } = await db.from('contacts').upsert({
        lead_id: l.id, company_id: l.company_id, name: p.name, title: p.title,
        quote: p.quote, quote_article_id: article.id,
        linkedin_search_url: linkedinSearchUrl(p.name, company),
        google_search_url: googleSearchUrl(p.name, company),
        email_status: 'unknown',
      }, { onConflict: 'lead_id,name' as any, ignoreDuplicates: true });
      if (error) console.log(`   could not save ${p.name}: ${error.code} ${error.message}`);
    }
  }
  console.log(write ? '\nwritten' : '\n(report only — pass --write to save)');
})();
