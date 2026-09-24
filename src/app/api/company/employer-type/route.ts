import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { setCompanyState } from '@/lib/workspace-state';

/**
 * Mark what a company actually is.
 *
 * The detector reads a name; a recruiter knows the company. The override is stored separately
 * from the detected value with who set it and when, so re-classification can never quietly
 * overwrite a person's judgement, and the decision can be argued with later.
 *
 *   POST { company_id, employer_type: 'end_client' | 'epc_contractor' | 'staffing_agency' | null, reason? }
 *
 * null clears the override and hands the company back to the detector.
 */
const ALLOWED = ['end_client', 'epc_contractor', 'staffing_agency', 'unknown'] as const;

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  try {
    const { company_id: companyId, employer_type: type, reason } = await req.json();
    if (!companyId) return NextResponse.json({ error: 'company_id required' }, { status: 400 });
    if (type !== null && !ALLOWED.includes(type)) {
      return NextResponse.json({ error: `employer_type must be one of ${ALLOWED.join(', ')}, or null to clear it` }, { status: 400 });
    }

    const db = supabaseAdmin();
    const { data: company } = await db.from('companies').select('id, name, employer_type')
      .eq('id', companyId).eq('workspace_id', me.workspace_id).maybeSingle();
    if (!company) return NextResponse.json({ error: 'company not found in this workspace' }, { status: 404 });

    // Item 20 step 2b: an override is ONE workspace's judgement of a company every workspace will
    // soon see, so it is stored per workspace. The owner's decision on 2026-09-24: a correction of a
    // crawled fact stays private even though it is arguably true for everyone, because one customer
    // must not silently rewrite another customer's view.
    //
    // The route reads and writes as the service role, so the workspace is passed explicitly — it is
    // not inferred from a session. The company was already refused above unless it is this
    // workspace's, which is what makes that safe.
    const patch = {
      employer_type_override: type,
      employer_type_set_by: type ? me.id : null,
      employer_type_set_at: type ? new Date().toISOString() : null,
      employer_type_reason: type ? (reason ?? null) : null,
    };
    const { error: stateError } = await setCompanyState(db, me.workspace_id, companyId, patch, me.id);
    if (stateError) return NextResponse.json({ error: stateError }, { status: 500 });
    // The old columns too, until 2c — see the note in workspace-state.ts on why 2b dual-writes.
    // NOTE for 2c: companies.employer_type_reason must NOT be dropped with the others. The crawl
    // writes it as a SHARED explanation of the DETECTED type (classify-employers, employer-verdict,
    // find-or-create-company all set it), which is a different fact from the reason a recruiter gives
    // for an override. Only the override's half moves.
    const { error } = await db.from('companies').update(patch).eq('id', companyId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      company: company.name,
      detected: company.employer_type,
      override: type,
      effective: type ?? company.employer_type ?? 'unknown',
      setBy: me.name ?? me.email,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
