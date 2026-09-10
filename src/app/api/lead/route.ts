import { NextResponse } from 'next/server';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { jdFromLead, screeningQuestions, draftOutreachChecked, scoreWithRightToWork, anonymize } from '@/lib/ai/documents';
import { checkRightToWork, searchCountriesFor } from '@/lib/right-to-work';
import { chooseRecipient } from '@/lib/contact-choice';
import { xrayCandidatesUrl, xrayLocalVariantUrl } from '@/lib/search-urls';
import { hasRightToWork, hasCandidateCountries } from '@/lib/schema-features';
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
    case 'questions': {
      const q = await screeningQuestions(lead.job_description ?? `${lead.project_name} — ${lead.trades_inferred?.join(', ')}`);
      // Right to work is asked first, because a "no" ends the call and everything else is wasted.
      const rtw = checkRightToWork(lead.country, {});
      const questions = rtw.question
        ? [{ q: rtw.question, good_answer: rtw.rule }, ...q.questions.filter((x: any) => !/passport|right to work|settled status|work visa/i.test(x.q))]
        : q.questions;
      return NextResponse.json({ questions, rightToWorkRule: rtw.rule });
    }
    case 'xray': {
      // The countries follow the work, not habit. Serbia was the old default and is wrong for
      // any EU or UK job: a Serbian welder needs a permit no client sponsors for a short scope.
      const { data: ws } = (await hasCandidateCountries(sb))
        ? await sb.from('workspaces').select('candidate_countries').eq('id', me.workspace_id).maybeSingle()
        : { data: null as any };
      const countries: string[] = b.countries?.length ? b.countries : searchCountriesFor(lead.country, ws?.candidate_countries ?? []);
      return NextResponse.json({
        url: xrayCandidatesUrl({
          roles: lead.trades_inferred?.length ? lead.trades_inferred : ['welder'],
          certs: ['ISO 9606', 'FROSIO', 'PCN', 'IRATA'],
          sectors: ['offshore', 'shipyard', 'North Sea', 'oil and gas'],
          countries,
        }),
        localUrl: xrayLocalVariantUrl({ roles: lead.trades_inferred?.length ? lead.trades_inferred : ['welder'], certs: ['ISO 9606', 'FROSIO', 'PCN', 'IRATA'], countries }, lead.country),
        countries, jobCountry: lead.country ?? null,
      });
    }
    case 'score_pool': {
      if (!lead.job_description) return NextResponse.json({ error: 'Create the job description first' }, { status: 400 });
      // Migration 0013 may not be applied yet, and naming a column that does not exist fails the
      // whole query rather than omitting a field.
      const cols = `id, reference_code, profile${(await hasRightToWork(sb)) ? ', nationality, eu_passport, uk_right_to_work, uk_right_to_work_basis' : ''}`;
      const { data: cands } = await sb.from('candidates').select(cols as '*')
        .eq('workspace_id', me.workspace_id).limit(60) as { data: any[] | null };
      const out = [];
      for (const c of cands ?? []) {
        // The blocker is keyed on the LEAD's country: where the work is, not where the person is.
        const s = await scoreWithRightToWork(anonymize(c.profile as any), [], lead.job_description, lead.country, c as any);
        const { rightToWork, ...row } = s;
        await sb.from('scores').insert({ candidate_id: c.id, lead_id: lead.id, jd_version: lead.jd_version, ...row });
        out.push({ ...c, ...s });
      }
      return NextResponse.json({ ranked: out.sort((a, b) => (a.blockers.length ? 1 : 0) - (b.blockers.length ? 1 : 0) || b.score - a.score).slice(0, 10) });
    }
    case 'draft': {
      if (!lead.confirmed_at) return NextResponse.json({ error: 'Confirm the source before drafting outreach' }, { status: 400 });
      // Who to write to. The quoted person is usually the CEO, and a CEO does not book welders.
      const contacts = (lead.contacts ?? []) as any[];
      const quoted = contacts.find((c) => c.quote) ?? contacts[0] ?? null;
      const { data: attendees } = await sb.from('people')
        .select('id, name, title, source').eq('workspace_id', me.workspace_id)
        .ilike('company_name', `%${(lead.companies?.name ?? '').split(' ')[0]}%`).limit(20);
      const pick = chooseRecipient(quoted, contacts.filter((c) => c !== quoted), attendees ?? []);

      const d = await draftOutreachChecked({
        company: lead.companies?.name, project: lead.project_name, phase: lead.phase,
        trades: lead.trades_inferred, rfbt_history: lead.companies?.rfbt_history, packs: b.packs ?? [],
        recipient: { name: pick.to.name, title: pick.to.title },
        hook: pick.hook ? { name: pick.hook.name, title: pick.hook.title, quote: (pick.hook as any).quote ?? quoted?.quote } : null,
        // What we can actually claim. Without this the draft invents certificates the pool does
        // not hold — "verified welders EN 9606, NDT Level II" against nothing on file.
        pool: await poolEvidence(sb, me.workspace_id),
      });
      // The recruiter is told who this is addressed to and why, before the model's own reasoning.
      const reasoning = `${pick.why} ${d.reasoning ?? ''}`.trim();
      const contactId = contacts.find((c) => c.name === pick.to.name)?.id ?? quoted?.id ?? null;
      const { data: o } = await sb.from('outreach').insert({ lead_id: lead.id, contact_id: contactId, channel: 'email', subject: d.subject, body: d.email, reasoning, status: 'draft' }).select().single();
      return NextResponse.json({ ...d, reasoning, outreach_id: o.id, recipient: pick.to, redirected: pick.redirected });
    }
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}

/**
 * What the workspace can honestly say about its own candidates: the certificates actually
 * confirmed with an issuer, the trades on file, and how many people are free. A draft email is
 * only allowed to cite these.
 */
async function poolEvidence(sb: any, workspaceId: string) {
  const { data: cands } = await sb.from('candidates')
    .select('trade, availability_from, profile').eq('workspace_id', workspaceId).limit(200);
  const { data: verified } = await sb.from('verifications')
    .select('result, valid_until, documents!inner(workspace_id, cert_body, extracted)')
    .eq('documents.workspace_id', workspaceId).eq('result', 'valid');

  const today = new Date().toISOString().slice(0, 10);
  const available = (cands ?? []).filter((c: any) => !c.availability_from || c.availability_from <= today).length;
  const trades = [...new Set((cands ?? []).flatMap((c: any) => c.profile?.trades ?? [c.trade]).filter(Boolean))];
  const projects = [...new Set((cands ?? []).flatMap((c: any) => (c.profile?.projects ?? []).map((p: any) => [p.type, p.country].filter(Boolean).join(', '))))].slice(0, 12);

  return {
    candidates_on_file: (cands ?? []).length,
    available,
    trades,
    projects,
    verified_certificates: (verified ?? []).map((v: any) => ({
      body: v.documents?.cert_body, level: v.documents?.extracted?.level ?? null,
      method: v.documents?.extracted?.method ?? null, valid_until: v.valid_until,
    })),
  };
}
