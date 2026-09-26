/**
 * Read only: what it would actually take to classify the companies that carry no industry.
 *
 *   npx tsx --env-file=.env.local scripts/company-classification-report.ts
 *
 * WHY A REPORT BEFORE ANY BACKFILL. The existing classifier is PURE — src/lib/industry.ts makes no model
 * call — so the cost question is not "what does classification cost" but "which companies have any signal
 * to classify FROM". classifyCompany reads exactly two things: the titles of a company's open adverts, and
 * the QUOTED passages inside employer_type_evidence. A company with neither yields nothing.
 *
 * And "yields nothing" does not mean "stays unclassified": finish() returns ['other'] when no rule matches,
 * so a blind backfill would write `industries = ['other']` with `industry_evidence = []` to every company
 * it cannot read — a positive claim drawn from an absence, on rows a capped customer's visibility then
 * depends on. That is the decision this report exists to inform, so it counts the populations separately
 * instead of reporting one number.
 *
 * It writes nothing and calls no model, so it is free to run as often as it is useful.
 */
import { createClient } from '@supabase/supabase-js';
import { classifyCompany, quotedIn } from '../src/lib/industry';
import { probeAdmin } from '../src/lib/test-data';

const db = probeAdmin();

/** Every row, in pages: PostgREST stops at 1000 in silence (CLAUDE.md, all-rows). */
async function every<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

(async () => {
  const companies = await every<any>((a, b) => db.from('companies')
    .select('id, name, industries, domain, careers_status, sector, sector_note, employer_type, employer_type_evidence, is_test')
    .order('id').range(a, b));
  const real = companies.filter((c) => !c.is_test);
  const unclassified = real.filter((c) => !c.industries || c.industries.length === 0);
  console.log(`companies: ${real.length} real (${companies.length - real.length} test)`);
  console.log(`  classified:   ${real.length - unclassified.length}`);
  console.log(`  UNCLASSIFIED: ${unclassified.length}   <-- the population in question\n`);

  // The live gap: an unclassified company with an OPEN posting is visible to every capped account today.
  const posts = await every<any>((a, b) => db.from('job_posts').select('id, company_id, title, status').eq('status', 'open').order('id').range(a, b));
  const titlesBy = new Map<string, string[]>();
  for (const p of posts) if (p.company_id) titlesBy.set(p.company_id, [...(titlesBy.get(p.company_id) ?? []), p.title].filter(Boolean));
  const unclassifiedWithPosts = unclassified.filter((c) => (titlesBy.get(c.id) ?? []).length > 0);
  console.log(`open postings: ${posts.length}`);
  console.log(`  on an UNCLASSIFIED company (the LIVE Hiring now gap): ${unclassifiedWithPosts.length} company(ies)`);
  console.log(`  on a classified company:                              ${posts.filter((p) => p.company_id && !unclassified.some((c) => c.id === p.company_id)).length} posting(s)\n`);

  // The latent gap: no posting today, but a board that a crawl will read.
  const withDomain = unclassified.filter((c) => c.domain);
  const withBoard = unclassified.filter((c) => c.careers_status === 'found');
  console.log(`of the ${unclassified.length} unclassified:`);
  console.log(`  have a domain (careers discovery is eligible to read them): ${withDomain.length}`);
  console.log(`  have careers_status 'found' (a board — WILL gain postings): ${withBoard.length}   <-- the latent gap\n`);

  // What signal exists at all. These are the only two inputs classifyCompany reads, plus the fields that
  // LOOK like signal and are deliberately not used.
  const sig = { adverts: 0, quotedEvidence: 0, neither: 0, sectorNote: 0, sector: 0 };
  for (const c of unclassified) {
    const titles = titlesBy.get(c.id) ?? [];
    const ev = typeof c.employer_type_evidence === 'string' ? c.employer_type_evidence : JSON.stringify(c.employer_type_evidence ?? '');
    const quoted = quotedIn(ev).length > 0;
    if (titles.length) sig.adverts++;
    if (quoted) sig.quotedEvidence++;
    if (!titles.length && !quoted) sig.neither++;
    if (c.sector_note) sig.sectorNote++;
    if (c.sector) sig.sector++;
  }
  console.log('signal classifyCompany can actually read:');
  console.log(`  advert titles:                 ${sig.adverts}`);
  console.log(`  quoted employer-type evidence: ${sig.quotedEvidence}`);
  console.log(`  NEITHER (no signal at all):    ${sig.neither}   <-- these can only become ['other'] with empty evidence`);
  console.log('fields that look like signal and are NOT used by the classifier:');
  console.log(`  sector_note set: ${sig.sectorNote}   sector set: ${sig.sector}   (sector is partly model-assigned — CLAUDE.md)\n`);

  // Dry run of the REAL function over every unclassified company: what would a backfill actually write?
  let realTag = 0, otherTag = 0;
  const examples: string[] = [];
  for (const c of unclassified) {
    const ev = typeof c.employer_type_evidence === 'string' ? c.employer_type_evidence : JSON.stringify(c.employer_type_evidence ?? '');
    const r = classifyCompany({ postingTitles: titlesBy.get(c.id) ?? [], employerEvidence: ev });
    const isOther = r.industries.length === 1 && r.industries[0] === 'other';
    if (isOther) otherTag++;
    else { realTag++; if (examples.length < 8) examples.push(`${c.name} -> ${r.industries.join(', ')} (${r.evidence[0]?.term ?? '?'} in ${r.evidence[0]?.where ?? '?'})`); }
  }
  console.log('DRY RUN — what the existing pure classifier would write today:');
  console.log(`  a REAL industry: ${realTag}`);
  console.log(`  ['other'] with no evidence: ${otherTag}`);
  for (const e of examples) console.log(`    e.g. ${e}`);
})().catch((e) => { console.error(`report failed: ${e.message}`); process.exitCode = 1; });
