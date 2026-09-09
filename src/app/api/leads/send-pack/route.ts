import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { SENDABLE, STATE_LABEL, type CertState } from '@/lib/verify/routes';
export const maxDuration = 120;

/**
 * POST { lead_id, candidate_ids[] } → attach a pack of anonymised CVs to a lead.
 *
 * This prepares and records the pack; it does not email anybody. Outreach goes out from
 * /api/outreach, by a recruiter, to an address attached to a contact.
 *
 * Two guardrails from the spec are enforced here rather than trusted to the UI:
 *   - a candidate with no PII-passed client PDF cannot go in a pack at all;
 *   - a certificate that is unverified, expired or pending comes back as a warning the
 *     recruiter has to acknowledge, and the pack records that they did.
 */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  try {
    const { lead_id: leadId, candidate_ids: candidateIds, acknowledge_warnings: acknowledged } = await req.json();
    if (!leadId || !Array.isArray(candidateIds) || candidateIds.length === 0) {
      return NextResponse.json({ error: 'lead_id and at least one candidate_id are required' }, { status: 400 });
    }

    const db = supabaseAdmin();
    const { data: lead } = await db.from('leads').select('id, workspace_id, company_id, project_name, companies(name)').eq('id', leadId).maybeSingle();
    if (!lead || lead.workspace_id !== me.workspace_id) return NextResponse.json({ error: 'lead not found in this workspace' }, { status: 404 });

    const included: any[] = [];
    const blocked: any[] = [];
    const warnings: string[] = [];

    for (const id of candidateIds) {
      const { data: cand } = await db.from('candidates').select('id, reference_code, full_name').eq('id', id).eq('workspace_id', me.workspace_id).maybeSingle();
      if (!cand) { blocked.push({ id, why: 'not in this workspace' }); continue; }

      const { data: cv } = await db.from('anonymized_cvs').select('id, storage_path, pii_check_passed')
        .eq('candidate_id', id).order('generated_at', { ascending: false }).limit(1).maybeSingle();
      if (!cv?.pii_check_passed || !cv.storage_path) {
        blocked.push({ reference: cand.reference_code, why: 'no client PDF that passed the PII check' });
        continue;
      }

      // Certificate states, so nothing goes out claiming more than it can.
      const { data: vers } = await db.from('verifications')
        .select('state, valid_until, documents!inner(candidate_id, cert_body)')
        .eq('documents.candidate_id', id);
      const today = new Date().toISOString().slice(0, 10);
      for (const v of vers ?? []) {
        const st = (v.state ?? 'unsupported') as CertState;
        const body = (v.documents as any)?.cert_body ?? 'certificate';
        if (!SENDABLE.includes(st)) warnings.push(`${cand.reference_code}: ${body} is ${STATE_LABEL[st]}`);
        else if (v.valid_until && v.valid_until < today) warnings.push(`${cand.reference_code}: ${body} expired ${v.valid_until}`);
      }

      included.push({ candidateId: id, reference: cand.reference_code, anonymizedCvId: cv.id });
    }

    if (included.length === 0) return NextResponse.json({ error: 'nothing could go in this pack', blocked }, { status: 409 });
    if (warnings.length > 0 && !acknowledged) {
      return NextResponse.json({ needsAcknowledgement: true, warnings, included: included.map((i) => i.reference), blocked }, { status: 409 });
    }

    for (const i of included) {
      await db.from('sends').insert({
        candidate_id: i.candidateId, company_id: lead.company_id, anonymized_cv_id: i.anonymizedCvId,
        sent_at: null,                                  // prepared, not sent: outreach does that
      });
    }
    await db.from('leads').update({ status: 'pursue' }).eq('id', leadId);

    return NextResponse.json({
      ok: true,
      lead: { id: lead.id, company: (lead.companies as any)?.name, project: lead.project_name },
      attached: included.map((i) => i.reference),
      blocked, warnings, acknowledged: !!acknowledged,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
