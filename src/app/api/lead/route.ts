import { NextResponse } from 'next/server';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { jdFromLead, screeningQuestions, draftOutreach, scoreAgainstJob, anonymize } from '@/lib/ai/documents';
import { xrayCandidatesUrl } from '@/lib/search-urls';
export const maxDuration = 120;
/** POST { lead_id, action: 'jd' | 'questions' | 'score_pool' | 'xray' | 'draft' | 'confirm' | 'status', ... } */
export async function POST(req: Request) {
  const me = await currentUser(); if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const sb = supabaseServer(); const b = await req.json();
  const { data: lead } = await sb.from('leads').select('*, companies(*), contacts(*), lead_articles(articles(text))').eq('id', b.lead_id).single();
  if (!lead) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const articleText = (lead.lead_articles?.[0] as any)?.articles?.text ?? '';
  switch (b.action) {
    case 'confirm': await sb.from('leads').update({ confirmed_by: me.id, confirmed_at: new Date().toISOString() }).eq('id', lead.id); return NextResponse.json({ ok: true });
    case 'status': await sb.from('leads').update({ status: b.status, updated_at: new Date().toISOString() }).eq('id', lead.id); return NextResponse.json({ ok: true });
    case 'jd': { const jd = await jdFromLead({ company: lead.companies?.name, project: lead.project_name, location: lead.project_location, trades: lead.trades_inferred, employer_type: lead.companies?.employer_type }, articleText); await sb.from('leads').update({ job_description: jd.job_description, jd_version: (lead.jd_version ?? 0) + 1 }).eq('id', lead.id); return NextResponse.json(jd); }
    case 'questions': return NextResponse.json(await screeningQuestions(lead.job_description ?? `${lead.project_name} — ${lead.trades_inferred?.join(', ')}`));
    case 'xray': return NextResponse.json({ url: xrayCandidatesUrl({ roles: lead.trades_inferred?.length ? lead.trades_inferred : ['welder'], certs: ['ISO 9606', 'FROSIO', 'PCN', 'IRATA'], sectors: ['offshore', 'shipyard', 'North Sea', 'oil and gas'], countries: ['Serbia', 'Romania', 'Poland', 'Croatia'] }) });
    case 'score_pool': {
      if (!lead.job_description) return NextResponse.json({ error: 'Create the job description first' }, { status: 400 });
      const { data: cands } = await sb.from('candidates').select('id, reference_code, profile').eq('workspace_id', me.workspace_id).limit(60);
      const out = [];
      for (const c of cands ?? []) { const s = await scoreAgainstJob(anonymize(c.profile as any), [], lead.job_description); await sb.from('scores').insert({ candidate_id: c.id, lead_id: lead.id, jd_version: lead.jd_version, ...s }); out.push({ ...c, ...s }); }
      return NextResponse.json({ ranked: out.sort((a, b) => (a.blockers.length ? 1 : 0) - (b.blockers.length ? 1 : 0) || b.score - a.score).slice(0, 10) });
    }
    case 'draft': {
      if (!lead.confirmed_at) return NextResponse.json({ error: 'Confirm the source before drafting outreach' }, { status: 400 });
      const contact = lead.contacts?.[0];
      const d = await draftOutreach({ company: lead.companies?.name, contact, project: lead.project_name, phase: lead.phase, trades: lead.trades_inferred, rfbt_history: lead.companies?.rfbt_history, packs: b.packs ?? [] });
      const { data: o } = await sb.from('outreach').insert({ lead_id: lead.id, contact_id: contact?.id, channel: 'email', subject: d.subject, body: d.email, reasoning: d.reasoning, status: 'draft' }).select().single();
      return NextResponse.json({ ...d, outreach_id: o.id });
    }
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
