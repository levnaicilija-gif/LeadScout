import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { hasCampaignFields } from '@/lib/schema-features';
export const maxDuration = 60;

/**
 * Trade cards and glossary terms, edited by a senior.
 *
 * A workspace never edits the shipped row. It writes its own, which shadows it — so the product
 * can ship a better card later without overwriting what RFBT has learned, and a bad edit can be
 * undone by deleting the workspace's copy rather than by remembering what the original said.
 *
 *   POST { kind: 'trade_card', trade, patch }
 *   POST { kind: 'glossary',  term,  patch }
 *   POST { kind: 'reset',     trade? | term? }   — drop this workspace's copy
 */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  if (me.role !== 'senior') return NextResponse.json({ error: 'Only a senior can edit trade cards and the glossary.' }, { status: 403 });

  const db = supabaseAdmin();
  // The tables arrive with 0018; until then say so rather than failing on an unknown relation.
  const { error: probe } = await db.from('trade_cards').select('id').limit(1);
  if (probe) return NextResponse.json({ error: 'Migration 0018 has not been applied yet.' }, { status: 503 });

  try {
    const b = await req.json();

    if (b.kind === 'trade_card') {
      if (!b.trade) return NextResponse.json({ error: 'trade is required' }, { status: 400 });
      const { data: shipped } = await db.from('trade_cards').select('*').is('workspace_id', null).eq('trade', b.trade).eq('lang', b.lang ?? 'en').maybeSingle();
      const { data, error } = await db.from('trade_cards').upsert({
        ...(shipped ? { ...shipped, id: undefined } : {}),
        workspace_id: me.workspace_id,
        trade: b.trade,
        lang: b.lang ?? 'en',
        title: b.patch?.title ?? shipped?.title ?? b.trade,
        ...b.patch,
        updated_by: me.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id,trade,lang' }).select().single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, card: data });
    }

    if (b.kind === 'glossary') {
      if (!b.term || !b.patch?.short) return NextResponse.json({ error: 'term and a one-line explanation are required' }, { status: 400 });
      const { data, error } = await db.from('glossary').upsert({
        workspace_id: me.workspace_id,
        term: b.term,
        lang: b.lang ?? 'en',
        category: b.patch.category ?? null,
        short: b.patch.short,
        long: b.patch.long ?? null,
        see_also: b.patch.see_also ?? [],
        updated_by: me.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id,term,lang' }).select().single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, term: data });
    }

    if (b.kind === 'reset') {
      const table = b.trade ? 'trade_cards' : 'glossary';
      const col = b.trade ? 'trade' : 'term';
      const val = b.trade ?? b.term;
      if (!val) return NextResponse.json({ error: 'trade or term is required' }, { status: 400 });
      const { error } = await db.from(table).delete().eq('workspace_id', me.workspace_id).eq(col, val);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, reset: val });
    }

    return NextResponse.json({ error: 'unknown kind' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
