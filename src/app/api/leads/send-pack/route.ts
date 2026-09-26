import { NextResponse } from 'next/server';
import { supabaseAdmin, supabaseServer, currentUser } from '@/lib/supabase/server';
import { SENDABLE, STATE_LABEL, type CertState } from '@/lib/verify/routes';
import { setLeadState } from '@/lib/workspace-state';
export const maxDuration = 120;

/**
 * POST { lead_id | campaign_id, candidate_ids[] } → attach a pack of anonymised CVs.
 *
 * This prepares and records the pack; it does not email anybody. Outreach goes out from
 * /api/outreach, by a recruiter, to an address attached to a contact.
 *
 * It takes a CAMPAIGN as well as a lead since 2026-09-21 (item 8's "Send N packs"). One route, not
 * two: every guardrail below — the PII-passed client version, the certificate states, the
 * prepared-not-sent record with who prepared it — is exactly what a campaign pack needs, and a second
 * route would have grown its own copy of all of it and then drifted. The only thing that differs is
 * which row names the client, and that a lead has a status to move where a campaign does not.
 *
 * A campaign's own "ready to send" (src/lib/campaign-docs.ts) answers a narrower question than the
 * warnings here: it looks only at the documents that campaign REQUIRES, while this looks at every
 * certificate on the candidate. So somebody can be ready for the campaign and still raise a warning
 * about an unrelated expired certificate. That is deliberate — the campaign decides who may go, this
 * decides what the recruiter is told before it leaves.
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
    const { lead_id: leadId, campaign_id: campaignId, candidate_ids: candidateIds, acknowledge_warnings: acknowledged } = await req.json();
    // A pack goes to a lead OR to a campaign, never both and never neither. Item 8 needed "Send N
    // packs" for a campaign's cleared people and this route already had every guardrail that needs —
    // the PII-passed client version, the certificate states, the prepared-not-sent record — so it
    // takes a campaign rather than a second route growing its own copy of them. Everything below this
    // point is unchanged and does not know which of the two it is serving.
    if ((!leadId && !campaignId) || (leadId && campaignId) || !Array.isArray(candidateIds) || candidateIds.length === 0) {
      return NextResponse.json({ error: 'exactly one of lead_id or campaign_id, and at least one candidate_id, are required' }, { status: 400 });
    }

    const db = supabaseAdmin();
    // ITEM 20 STEP 3F: THE LEAD IS AUTHORISED BY VISIBILITY, THE CAMPAIGN AND THE CANDIDATES BY OWNERSHIP,
    // AND THE DIFFERENCE IS THE WHOLE POINT OF THIS STEP. leads is a SHARED table: its workspace_id means
    // "who crawled it" (RFBT on all 238), so comparing it with me.workspace_id was right while leads were
    // private and becomes a LOCK once they are shared — a second workspace could open a lead, read its
    // drawer, and be told the lead does not exist when it tried to prepare a pack. Reading as the signed-in
    // user hands that decision to 0053's policy instead.
    //
    // The two checks BELOW are deliberately left exactly as they are. campaigns and candidates are PRIVATE
    // tables — candidates holds names, dates of birth, passports and right-to-work facts — so ownership is
    // the correct rule there and loosening it to visibility would be a data leak, not a fix. "Fix the
    // workspace_id checks" is three checks in this file and only one of them is wrong.
    const asUser = supabaseServer();
    const { data: lead } = leadId
      ? await asUser.from('leads').select('id, workspace_id, company_id, project_name, companies(name)').eq('id', leadId).maybeSingle()
      : { data: null as any };
    if (leadId && !lead) return NextResponse.json({ error: 'no such lead, or it is not visible to this account' }, { status: 404 });

    const { data: campaign } = campaignId
      ? await db.from('campaigns').select('id, workspace_id, company_id, name, companies(name)').eq('id', campaignId).maybeSingle()
      : { data: null as any };
    if (campaignId && (!campaign || campaign.workspace_id !== me.workspace_id)) return NextResponse.json({ error: 'campaign not found in this workspace' }, { status: 404 });

    /** Whichever of the two this pack is for — the client it goes to, and what to call it. */
    const target = lead
      ? { kind: 'lead' as const, id: lead.id, companyId: lead.company_id, client: (lead.companies as any)?.name ?? null, what: lead.project_name }
      : { kind: 'campaign' as const, id: campaign.id, companyId: campaign.company_id, client: (campaign.companies as any)?.name ?? null, what: campaign.name };

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
        candidate_id: i.candidateId, company_id: target.companyId, anonymized_cv_id: i.anonymizedCvId,
        sent_at: null,                                  // prepared, not sent: outreach does that
        sent_by: me.id,                                 // who prepared it — until 2026-09-15 a pack recorded nobody (cv-sent-entry.ts)
      });
    }
    // Only a lead has a status to move. A campaign's own status means something else entirely —
    // whether the batch is still running — and is not this route's to touch.
    // Item 20 step 2b: "we are pursuing this" is THIS workspace's decision, so it goes to
    // workspace_lead_state, which is where every read now takes it from. `me.workspace_id` is safe to
    // pass because the lead was already refused above unless it belongs to it.
    if (target.kind === 'lead') {
      const { error } = await setLeadState(db, me.workspace_id, target.id, { status: 'pursue' }, me.id);
      if (error) return NextResponse.json({ error: `the pack was prepared but the lead was not moved to Pursue: ${error}` }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      // Kept for callers written against the old shape; `target` is the one to read from now on.
      ...(target.kind === 'lead' ? { lead: { id: target.id, company: target.client, project: target.what } } : {}),
      target: { kind: target.kind, id: target.id, client: target.client, what: target.what },
      attached: included.map((i) => i.reference),
      blocked, warnings, acknowledged: !!acknowledged,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
