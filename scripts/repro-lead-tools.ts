/**
 * Run each lead-drawer tool outside the request, so a failure names the stage instead of
 * arriving in the UI as a button stuck on "Writing…".
 *
 *   npx tsx --env-file=.env.local scripts/repro-lead-tools.ts <lead_id>
 */
import { createClient } from '@supabase/supabase-js';
import { jdFromLead, screeningQuestions, draftOutreach, scoreAgainstJob, anonymize } from '../src/lib/ai/documents';

const leadId = process.argv[2];
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
  const t = Date.now();
  try {
    const out = await fn();
    console.log(`\n=== ${name} — ok in ${Math.round((Date.now() - t) / 1000)}s`);
    return out;
  } catch (e: any) {
    console.log(`\n=== ${name} — FAILED in ${Math.round((Date.now() - t) / 1000)}s`);
    console.log(String(e?.message ?? e).slice(0, 1200));
    return null;
  }
};

(async () => {
  const { data: lead, error } = await db.from('leads')
    .select('*, companies(*), contacts(*), lead_articles(articles(text))')
    .eq('id', leadId).single();
  if (error || !lead) { console.error('lead not found:', error?.message); process.exit(1); }

  const articleText = (lead.lead_articles?.[0] as any)?.articles?.text ?? '';
  console.log(`${lead.companies?.name} — ${lead.project_name}`);
  console.log(`  employer_type ${lead.companies?.employer_type} · trades ${JSON.stringify(lead.trades_inferred)}`);
  console.log(`  article text: ${articleText.length} chars · contacts: ${lead.contacts?.length ?? 0} · confirmed: ${lead.confirmed_at ? 'yes' : 'no'}`);

  const jd = await stage('jd', () => jdFromLead({
    company: lead.companies?.name, project: lead.project_name, location: lead.project_location,
    trades: lead.trades_inferred, employer_type: lead.companies?.employer_type,
  }, articleText));
  if (jd) {
    console.log((jd as any).job_description);
    if ((jd as any).assumptions?.length) console.log(`\nAssumed: ${(jd as any).assumptions.join(' · ')}`);
  }

  const jdText = (jd as any)?.job_description ?? lead.job_description ?? `${lead.project_name} — ${(lead.trades_inferred ?? []).join(', ')}`;

  const q = await stage('questions', () => screeningQuestions(jdText));
  (q as any)?.questions?.forEach((x: any, i: number) => console.log(`${i + 1}. ${x.q}\n   good: ${x.good_answer}`));

  const { data: cands } = await db.from('candidates').select('id, reference_code, profile').eq('workspace_id', lead.workspace_id).limit(5);
  console.log(`\n(scoring ${(cands ?? []).length} candidates)`);
  for (const c of cands ?? []) {
    const s = await stage(`score_pool ${c.reference_code}`, () => scoreAgainstJob(anonymize(c.profile as any), [], jdText));
    if (s) console.log(`   ${(s as any).score} · fits ${(s as any).fits.slice(0, 2).join(', ')} · blockers ${(s as any).blockers.join(', ') || 'none'}`);
  }

  const d = await stage('draft', () => draftOutreach({
    company: lead.companies?.name, contact: lead.contacts?.[0], project: lead.project_name,
    phase: lead.phase, trades: lead.trades_inferred, rfbt_history: lead.companies?.rfbt_history, packs: [],
  }));
  if (d) {
    console.log(`Subject: ${(d as any).subject}\n`);
    console.log((d as any).email);
    console.log(`\nreasoning: ${(d as any).reasoning}`);
  }
})();
