import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { isEea, isUk } from '@/lib/right-to-work';

/**
 * Where this workspace looks for candidates.
 *
 * Only EU, EEA and UK are accepted. Anywhere else needs a permit a client would have to sponsor,
 * and the search that reads this list is what decides who a recruiter is shown for every job —
 * so a wrong entry here is not a preference, it is wasted calls.
 */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  if (me.role !== 'senior') return NextResponse.json({ error: 'Only a senior can change this.' }, { status: 403 });

  try {
    const { countries } = await req.json();
    if (!Array.isArray(countries)) return NextResponse.json({ error: 'countries must be a list' }, { status: 400 });

    const clean = [...new Set(countries.map((c: any) => String(c).trim().toUpperCase()))].filter(Boolean);
    const outside = clean.filter((c) => !isEea(c) && !isUk(c));
    if (outside.length) {
      return NextResponse.json({ error: `Outside the EU, EEA and UK: ${outside.join(', ')}. Those need a work permit the client would have to sponsor.` }, { status: 400 });
    }

    const db = supabaseAdmin();
    const { error } = await db.from('workspaces').update({ candidate_countries: clean }).eq('id', me.workspace_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, countries: clean });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
