import type { SupabaseClient } from '@supabase/supabase-js';
import { classifyAward, classifyNews, classifyCompany, repeatedSentences, INDUSTRIES, type IndustryEvidence, type IndustryId } from '@/lib/industry';
import { leadSource } from '@/lib/lead-source';
import { hasIndustries } from '@/lib/schema-features';
import { LEAD_STATE_LEFT, withLeadState } from '@/lib/workspace-state';

/**
 * Where industries are written as leads and adverts arrive (0031). scripts/industry-backfill.ts did the rows already
 * stored; Radar, the TED award ingest and the job crawl call these for each new one.
 *
 * Neither throws. A crawl that has just saved a real lead must not lose it because classifying failed, so each
 * returns what went wrong for the caller to put in its report — never swallowed, never fatal.
 */

/** How many of the site's stored stories are read to find the lines it repeats. */
const SITE_STORIES = 40;
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const OPEN = (s: string | null) => s !== 'stale' && s !== 'not_for_us';

export async function classifyAndStoreLead(db: SupabaseClient, leadId: string): Promise<string | null> {
  try {
    if (!(await hasIndustries(db))) return null;
    const { data: lead, error } = await db.from('leads').select('id, project_name, source_url, lead_articles(articles(url, title, text))').eq('id', leadId).maybeSingle();
    if (error || !lead) return `lead ${leadId} could not be read: ${error?.message ?? 'not found'}`;
    const arts = ((lead as any).lead_articles ?? []).map((r: any) => r.articles).filter(Boolean);
    const primary = arts.find((a: any) => a.url === (lead.source_url ?? '').split('#')[0]) ?? arts[0];
    let result;
    if (leadSource(lead.source_url) === 'tender') {
      result = classifyAward(primary?.text ?? '');
    } else {
      const host = hostOf(primary?.url ?? '');
      const { data: siteStories } = host
        ? await db.from('articles').select('url, text').ilike('url', `%://${host}/%`).order('fetched_at', { ascending: false }).limit(SITE_STORIES)
        : { data: [] as any[] };
      const siteLines = repeatedSentences([...(siteStories ?? []), ...(primary ? [primary] : [])].filter((a, i, all) => all.findIndex((b) => b.url === a.url) === i));
      result = classifyNews({ title: primary?.title, projectName: lead.project_name, text: primary?.text, url: primary?.url }, siteLines);
    }
    const { error: upErr } = await db.from('leads').update({ industries: result.industries, industry_evidence: result.evidence, industries_at: new Date().toISOString() }).eq('id', leadId);
    return upErr ? `industries for lead ${leadId} not stored: ${upErr.message}` : null;
  } catch (e: any) {
    return `industries for lead ${leadId}: ${String(e?.message ?? e).slice(0, 160)}`;
  }
}

export async function refreshCompanyIndustries(db: SupabaseClient, companyId: string): Promise<string | null> {
  try {
    if (!(await hasIndustries(db))) return null;
    const { data: co, error } = await db.from('companies').select('id, employer_type_evidence').eq('id', companyId).maybeSingle();
    if (error || !co) return `company ${companyId} could not be read: ${error?.message ?? 'not found'}`;
    const { data: posts } = await db.from('job_posts').select('title').eq('company_id', companyId).eq('status', 'open').limit(100);
    // Item 20 step 2b: whether a lead is open comes from the workspace's state row. A LEFT join, not
    // `!inner` — this is evidence-gathering, and a lead whose state row were missing should still be
    // considered rather than silently dropped from the classification.
    const { data: leadRows } = await db.from('leads').select(`status, industry_evidence, ${LEAD_STATE_LEFT}`).eq('company_id', companyId).limit(200);
    const leads = (leadRows ?? []).map(withLeadState);
    const own = classifyCompany({
      postingTitles: (posts ?? []).map((p: any) => p.title),
      employerEvidence: typeof co.employer_type_evidence === 'string' ? co.employer_type_evidence : JSON.stringify(co.employer_type_evidence ?? ''),
    });
    const evidence: IndustryEvidence[] = [...own.evidence];
    for (const l of (leads ?? []).filter((x: any) => OPEN(x.status))) {
      for (const e of (l.industry_evidence ?? []) as IndustryEvidence[]) evidence.push({ ...e, where: `open lead — ${e.where}` });
    }
    const industries = INDUSTRIES.map((i) => i.id).filter((id) => id !== 'other' && evidence.some((e) => e.industry === id)) as IndustryId[];
    const { error: upErr } = await db.from('companies').update({ industries: industries.length ? industries : ['other'], industry_evidence: evidence, industries_at: new Date().toISOString() }).eq('id', companyId);
    return upErr ? `industries for company ${companyId} not stored: ${upErr.message}` : null;
  } catch (e: any) {
    return `industries for company ${companyId}: ${String(e?.message ?? e).slice(0, 160)}`;
  }
}
