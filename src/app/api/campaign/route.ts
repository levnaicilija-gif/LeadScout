import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
export const maxDuration = 60;

/**
 * Campaigns: a batch of people going to one client for one scope.
 *
 * The value is the gap, not the list — a campaign starting in three weeks with four people
 * missing a medical is the most urgent thing on a recruiter's desk. So the required documents
 * are part of creating one, and Today reads them.
 *
 *   POST { action: 'create',  name, company_id?, site?, country?, starts_on?, ends_on?, required_docs? }
 *   POST { action: 'add',     campaign_id, candidate_ids: [] }
 *   POST { action: 'remove',  campaign_id, candidate_id }
 *   POST { action: 'status',  campaign_id, status }
 */
const DOCS = ['passport', 'cv', 'certificate', 'medical', 'a1', 'test_report', 'contract', 'other'];

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  try {
    const b = await req.json();
    const db = supabaseAdmin();

    switch (b.action) {
      case 'create': {
        const name = String(b.name ?? '').trim();
        if (!name) return NextResponse.json({ error: 'A campaign needs a name.' }, { status: 400 });
        const required = Array.isArray(b.required_docs) ? b.required_docs.filter((d: string) => DOCS.includes(d)) : ['passport', 'medical', 'certificate', 'a1'];
        const { data, error } = await db.from('campaigns').insert({
          workspace_id: me.workspace_id, name,
          company_id: b.company_id ?? null, site: b.site ?? null, country: b.country ?? null,
          starts_on: b.starts_on || null, ends_on: b.ends_on || null,
          required_docs: required, status: 'active', created_by: me.id,
        }).select().single();
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true, campaign: data });
      }

      case 'add': {
        const ids: string[] = Array.isArray(b.candidate_ids) ? b.candidate_ids : [];
        if (!b.campaign_id || !ids.length) return NextResponse.json({ error: 'campaign_id and at least one candidate are required' }, { status: 400 });
        // Only candidates from this workspace, so a campaign cannot reach across one.
        const { data: mine } = await db.from('candidates').select('id').eq('workspace_id', me.workspace_id).in('id', ids);
        const allowed = (mine ?? []).map((c) => c.id);
        if (!allowed.length) return NextResponse.json({ error: 'none of those candidates are in this workspace' }, { status: 400 });
        const { error } = await db.from('campaign_candidates').upsert(
          allowed.map((id) => ({ campaign_id: b.campaign_id, candidate_id: id, added_by: me.id })),
          { onConflict: 'campaign_id,candidate_id' },
        );
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true, added: allowed.length });
      }

      case 'remove': {
        const { error } = await db.from('campaign_candidates').delete()
          .eq('campaign_id', b.campaign_id).eq('candidate_id', b.candidate_id);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      case 'status': {
        const { error } = await db.from('campaigns').update({ status: b.status })
          .eq('id', b.campaign_id).eq('workspace_id', me.workspace_id);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
