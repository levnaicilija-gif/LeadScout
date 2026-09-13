/**
 * Are a news story and an award notice — or two award notices — about the same contract?
 *
 * The same win is often reported twice: the contractor's press release in the week of the award,
 * and the buyer's TED notice weeks later. Two leads for one contract means two people calling one
 * company about one job, so the second source is linked to the first lead as corroboration.
 *
 * Deliberately cautious, like company identity, because a wrong merge hides a real second contract
 * behind the first. Nothing here reads meaning into text; only these count:
 *
 *   news ↔ award   the same company (company_id, from findOrCreateCompany) AND the award's
 *                  contracting authority named in the story, AND within a year of each other;
 *   award ↔ award  the same company AND the same contracting authority AND the same title, within
 *                  a year — a notice republished or corrected, not a second contract;
 *   anything else  not the same contract.
 *
 * If more than one lead qualifies, nothing is merged: the story could be about either.
 *
 * The earlier record is canonical — but only when both dates are real. An award is dated by its TED
 * publication date. A news story's own date is not captured (articles.published_at is empty on
 * every row Radar has written), and the date Radar first read it is not the date it was published:
 * Aker Solutions' KN Energies release says "March 19, 2026", its TED notice is dated 23 March, and
 * Radar first read the release on 10 September. Comparing on that would make the notice look
 * earlier when it is not. So with a date unknown the lead's canonical source stays as it is, and the
 * reason says why.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { canonCompany } from './company-identity';
import { leadSource, type LeadSource } from './lead-source';
import { buyersFromAwardText, publishedFromAwardText } from './tender/award';

export const SAME_CONTRACT_WINDOW_DAYS = 365;

export type SourceRecord = {
  kind: LeadSource;
  /** The URL the lead points at when this record is canonical. */
  url: string;
  /** YYYY-MM-DD — the record's own date when dateKnown, otherwise when it was first read. */
  date: string;
  dateKnown: boolean;
  text: string;
  buyers: string[];
  title: string | null;
};

type Existing = SourceRecord & { leadId: string };

export type SameContract =
  | { match: true; leadId: string; existing: Omit<Existing, 'text'>; why: string }
  | { match: false; ambiguous: string[]; why: string };

/** A name, as whole words of canonical text: legal forms, accents and punctuation gone. */
export function namedIn(text: string, name: string) {
  const n = canonCompany(name);
  // "AB" or "AS" alone canonicalises to nothing useful; four letters is the floor for a name.
  if (n.replace(/\s/g, '').length < 4) return false;
  return ` ${canonCompany(text)} `.includes(` ${n} `);
}

const days = (a: string, b: string) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86400000;

const describe = (r: { kind: LeadSource; date: string; dateKnown: boolean }) =>
  `${r.kind === 'tender' ? 'award notice' : 'news story'} ${r.dateKnown ? `dated ${r.date}` : `first read ${r.date}, own date not captured`}`;

/** The lead's record as it stands: its canonical source, and the text of every article linked to it. */
function existingFrom(lead: any): Existing {
  const kind = leadSource(lead.source_url);
  const articles: any[] = (lead.lead_articles ?? []).map((la: any) => la.articles).filter(Boolean);
  const canonical = articles.find((a) => lead.source_url && String(lead.source_url).startsWith(a.url)) ?? articles[0];
  const published = kind === 'tender' ? publishedFromAwardText(canonical?.text ?? '') : canonical?.published_at ?? null;
  return {
    leadId: lead.id,
    kind,
    url: lead.source_url,
    date: String(published ?? canonical?.fetched_at ?? lead.created_at).slice(0, 10),
    dateKnown: !!published,
    text: articles.map((a) => a.text ?? '').join('\n\n'),
    buyers: articles.filter((a) => leadSource(a.url) === 'tender').flatMap((a) => buyersFromAwardText(a.text ?? '')),
    title: lead.project_name ?? null,
  };
}

export async function findSameContract(db: SupabaseClient, input: { workspaceId: string; companyId: string; incoming: SourceRecord }): Promise<SameContract> {
  const { data: leads, error } = await db.from('leads')
    .select('id, source_url, project_name, created_at, lead_articles(articles(id, url, text, published_at, fetched_at))')
    .eq('workspace_id', input.workspaceId).eq('company_id', input.companyId).eq('kind', 'won_work');
  // Failing to read is not finding nothing: say so rather than create a duplicate quietly.
  if (error) throw new Error(`could not read this company's leads to check for the same contract: ${error.message}`);

  const inc = input.incoming;
  const hits: { e: Existing; why: string }[] = [];
  for (const lead of leads ?? []) {
    const e = existingFrom(lead);
    if (e.url === inc.url) continue;
    const gap = days(e.date, inc.date);
    if (gap > SAME_CONTRACT_WINDOW_DAYS) continue;
    const apart = `${Math.round(gap)} days apart`;

    if (inc.kind === 'tender' && e.kind === 'news') {
      const buyer = inc.buyers.find((b) => namedIn(e.text, b));
      if (buyer) hits.push({ e, why: `contracting authority "${buyer}" is named in the news story, ${apart}` });
    } else if (inc.kind === 'news' && e.kind === 'tender') {
      const buyer = e.buyers.find((b) => namedIn(inc.text, b));
      if (buyer) hits.push({ e, why: `contracting authority "${buyer}" is named in the news story, ${apart}` });
    } else if (inc.kind === 'tender' && e.kind === 'tender') {
      const buyer = inc.buyers.find((b) => e.buyers.some((x) => canonCompany(x) === canonCompany(b)));
      const sameTitle = !!inc.title && !!e.title && canonCompany(inc.title) === canonCompany(e.title);
      if (buyer && sameTitle) hits.push({ e, why: `same contracting authority "${buyer}" and the same title, ${apart}` });
    }
  }

  if (hits.length === 1) {
    const { text: _text, ...existing } = hits[0].e;
    return { match: true, leadId: existing.leadId, existing, why: hits[0].why };
  }
  if (hits.length > 1) return { match: false, ambiguous: hits.map((h) => h.e.leadId), why: `${hits.length} leads for this company could be this contract — not merged` };
  return { match: false, ambiguous: [], why: 'no lead for this company matches' };
}

/** Which record is canonical, and why — decided without writing anything. */
export function canonicalOf(existing: Omit<SourceRecord, 'text'>, incoming: Omit<SourceRecord, 'text'>) {
  if (!existing.dateKnown || !incoming.dateKnown) {
    return { canonical: 'existing' as const, why: `canonical unchanged: ${describe(existing.dateKnown ? incoming : existing)}, so which came first is not known` };
  }
  if (incoming.date < existing.date) return { canonical: 'incoming' as const, why: `the ${describe(incoming)} is earlier than the ${describe(existing)}, so it becomes canonical` };
  return { canonical: 'existing' as const, why: `the ${describe(existing)} is not later than the ${describe(incoming)}, so it stays canonical` };
}

/**
 * Link the second source to the lead that already covers the contract, and make the earlier record
 * canonical when that is knowable. The lead keeps its id, so contacts, scores and outreach written
 * against it stay attached; only its source moves.
 */
export async function mergeSameContract(
  db: SupabaseClient,
  match: Extract<SameContract, { match: true }>,
  incoming: SourceRecord,
  articleId: string,
  fill: { project_value?: string | null; country?: string | null; region?: string | null } = {},
) {
  const { error: linkError } = await db.from('lead_articles').upsert({ lead_id: match.leadId, article_id: articleId });
  if (linkError) throw new Error(`could not link the second source to lead ${match.leadId}: ${linkError.message}`);

  const decision = canonicalOf(match.existing, incoming);
  if (decision.canonical === 'incoming') {
    const { data: lead } = await db.from('leads').select('project_value, country').eq('id', match.leadId).maybeSingle();
    const patch: Record<string, unknown> = { source_url: incoming.url, source_fetched_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    // Fill a gap from the canonical record; never overwrite what the lead already says.
    if (!lead?.project_value && fill.project_value) patch.project_value = fill.project_value;
    if (!lead?.country && fill.country) { patch.country = fill.country; patch.region = fill.region ?? null; }
    const { error } = await db.from('leads').update(patch).eq('id', match.leadId);
    if (error) throw new Error(`could not make the earlier source canonical on lead ${match.leadId}: ${error.message}`);
  }
  return { canonical: decision.canonical, why: `${match.why}; ${decision.why}` };
}
