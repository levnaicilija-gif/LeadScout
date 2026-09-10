import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';

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

    const { error } = await db.from('companies').update({
      employer_type_override: type,
      employer_type_set_by: type ? me.id : null,
      employer_type_set_at: type ? new Date().toISOString() : null,
      employer_type_reason: type ? (reason ?? null) : null,
    }).eq('id', companyId);
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
