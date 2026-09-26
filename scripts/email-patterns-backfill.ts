/**
 * Queue item 14 (3): email patterns from every article already stored. Regex only, no model.
 *
 *   npx tsx --env-file=.env.local scripts/email-patterns-backfill.ts            # report
 *   npx tsx --env-file=.env.local scripts/email-patterns-backfill.ts --write    # write (needs 0023)
 *
 * An article is read for the companies it belongs to: the company of any lead it is linked to, and
 * a company whose own domain the article is hosted on. The rules are src/lib/email-pattern.ts.
 */
import { createClient } from '@supabase/supabase-js';
import { observePatterns, recordEmailPatterns, type Observation } from '../src/lib/email-pattern';
import { canonDomain } from '../src/lib/company-identity';
import { hasEmailPatterns } from '../src/lib/schema-features';
import { probeAdmin } from '../src/lib/test-data';

const db = probeAdmin();
const WRITE = process.argv.includes('--write');

async function all<T>(q: (from: number) => PromiseLike<{ data: T[] | null; error: any }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) return rows;
  }
}

(async () => {
  const tableOn = await hasEmailPatterns(db);
  if (WRITE && !tableOn) { console.error('company_email_patterns does not exist yet — apply migration 0023 first'); process.exit(1); }
  const { data: ws } = await db.from('workspaces').select('id').eq('name', 'RFBT Recruitment').single();
  const companies = await all<any>((f) => db.from('companies').select('id, name, domain').eq('workspace_id', ws!.id).eq('is_test', false).range(f, f + 999));
  const byId = new Map(companies.map((c) => [c.id, c]));
  const byDomain = new Map(companies.filter((c) => c.domain).map((c) => [canonDomain(c.domain), c]));
  const articles = await all<any>((f) => db.from('articles').select('id, url, text, fetched_at, lead_articles(leads(company_id, is_test))').not('url', 'ilike', 'https://ted.europa.eu/%').range(f, f + 999));

  const perCompany = new Map<string, Observation[]>();
  let addresses = 0;
  for (const a of articles) {
    if (!/@/.test(a.text ?? '')) continue;
    const owners = new Set<string>();
    for (const la of a.lead_articles ?? []) if (la.leads?.company_id && !la.leads.is_test) owners.add(la.leads.company_id);
    try { const host = canonDomain(new URL(a.url).hostname); for (const [d, c] of byDomain) if (host === d || host.endsWith(`.${d}`)) owners.add(c.id); } catch { /* not a URL */ }
    for (const id of owners) {
      const c = byId.get(id);
      if (!c) continue;
      const obs = observePatterns({ text: a.text, url: a.url, readAt: a.fetched_at }, c);
      addresses += obs.length;
      if (obs.length) perCompany.set(id, [...(perCompany.get(id) ?? []), ...obs]);
    }
  }

  console.log(`${WRITE ? 'WRITING' : 'dry run'} · 0023 applied: ${tableOn} · articles with an @: ${articles.filter((a) => /@/.test(a.text ?? '')).length} of ${articles.length} · observations: ${addresses} across ${perCompany.size} companies\n`);
  for (const [id, obs] of perCompany) {
    const c = byId.get(id)!;
    const rows = await recordEmailPatterns(db, ws!.id, id, obs, { dryRun: !WRITE });
    for (const r of rows) console.log(`  ${c.name.padEnd(28)} ${r.domain.padEnd(24)} ${r.pattern.padEnd(11)} ${r.confidence.padEnd(6)} ${r.observed_count} seen, ${r.corroborated_count} beside a name · ${r.examples.map((e: any) => e.address).join(', ')}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
