import { NextResponse } from 'next/server';
import { supabaseAdmin, supabaseServer, currentUser } from '@/lib/supabase/server';
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
    // ITEM 20 STEP 3F: AUTHORISED BY VISIBILITY, NOT BY OWNERSHIP. This read used to run as the SERVICE ROLE
    // with `.eq('workspace_id', me.workspace_id)` bolted on as the permission check, which was correct while
    // companies were private and INVERTS THE MOMENT THEY ARE SHARED — exactly as 0047's WITH CHECK did before
    // 0051 re-keyed it. companies.workspace_id now means "who crawled it" (all 5,899 say RFBT), not "who may
    // work on it", so a second workspace could see a company on Hiring now and be told the company does not
    // exist when it tried to correct the employer type. Not an error either: a 404, once per company.
    //
    // Reading as the SIGNED-IN USER hands the decision to 0053's policy, which is the one place the visibility
    // rule lives. The write below stays on the service role and stays keyed to me.workspace_id, because an
    // override is ONE workspace's judgement and must never be written into anybody else's state row.
    const asUser = supabaseServer();
    const { data: company } = await asUser.from('companies').select('id, name, employer_type')
      .eq('id', companyId).maybeSingle();
    if (!company) return NextResponse.json({ error: 'no such company, or it is not visible to this account' }, { status: 404 });

    // Item 20 step 2b: an override is ONE workspace's judgement of a company every workspace will
    // soon see, so it is stored per workspace. The owner's decision on 2026-09-24: a correction of a
    // crawled fact stays private even though it is arguably true for everyone, because one customer
    // must not silently rewrite another customer's view.
    //
    // The WRITE runs as the service role, so the workspace is passed explicitly rather than inferred from a
    // session. What makes that safe is no longer "the company belongs to this workspace" — since 3f the read
    // above refuses anything this account cannot SEE, and the workspace written to is always me.workspace_id.
    // So a workspace can record its own judgement about any company it can see, and can never write into
    // another workspace's row. (This comment said the opposite until 3f; it was true of the ownership check
    // it described and became false the moment companies were shared.)
    const patch = {
      employer_type_override: type,
      employer_type_set_by: type ? me.id : null,
      employer_type_set_at: type ? new Date().toISOString() : null,
      employer_type_reason: type ? (reason ?? null) : null,
    };
    // Item 20 step 2c: the override is written ONLY to the workspace's own row now. The matching
    // write to companies was 2b's rollback copy and is gone.
    //
    // STILL TRUE FOR THE DROP MIGRATION: companies.employer_type_reason must NOT be dropped with the
    // others. The crawl writes it as a SHARED explanation of the DETECTED type — classify-employers,
    // employer-verdict and find-or-create-company all set it, on 525 of the 528 companies that carry
    // one — which is a different fact from the reason a recruiter gives for an override. Only the
    // override's half moved.
    const { error } = await setCompanyState(db, me.workspace_id, companyId, patch, me.id);
    if (error) return NextResponse.json({ error }, { status: 500 });

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
