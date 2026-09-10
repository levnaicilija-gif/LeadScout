import { NextResponse } from 'next/server';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
export const maxDuration = 60;

/**
 * GET /api/leads/open → the open leads and job posts a candidate can be scored against.
 *
 * One list, both kinds, labelled "company · role · location" as the dropdown shows them. A
 * lead carries whatever job description it has: the saved JD if a recruiter wrote one,
 * otherwise the posting or project detail we hold, so scoring has something real to work from.
 */
export async function GET() {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  const sb = supabaseServer();
  const { data } = await sb.from('leads')
    .select('id, kind, project_name, project_location, country, fit_score, job_description, trades_inferred, companies(name), job_posts(role, location, certs_required, rotation, headcount, contract_type)')
    .not('status', 'in', '("stale","not_for_us")')
    .order('fit_score', { ascending: false })
    .limit(60);

  const options = (data ?? []).map((l: any) => {
    const jp = l.job_posts?.[0];
    const role = jp?.role ?? l.project_name ?? 'role not stated';
    const where = jp?.location ?? l.project_location ?? l.country ?? '';
    return {
      id: l.id,
      kind: l.kind,
      // The country the work is in — right to work is keyed on it.
      country: l.country ?? null,
      label: [l.companies?.name, role, where].filter(Boolean).join(' · '),
      fit: l.fit_score,
      // What the scorer actually reads.
      jd: l.job_description || [
        `${l.companies?.name ?? 'Company'} — ${role}`,
        where && `Location: ${where}`,
        jp?.headcount && `Headcount: ${jp.headcount}`,
        jp?.rotation && `Rotation: ${jp.rotation}`,
        jp?.contract_type && `Contract: ${jp.contract_type}`,
        jp?.certs_required?.length && `Certificates required: ${jp.certs_required.join(', ')}`,
        l.trades_inferred?.length && `Trades: ${l.trades_inferred.join(', ')}`,
        l.project_name && l.kind === 'won_work' && `Project: ${l.project_name}`,
      ].filter(Boolean).join('\n'),
    };
  });

  return NextResponse.json({ options });
}
