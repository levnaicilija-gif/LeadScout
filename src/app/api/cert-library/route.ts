import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { writeEntry } from '@/lib/certs/library';
import { hasCertLibrary } from '@/lib/schema-features';
export const maxDuration = 30;

/**
 * The certificate library, as a senior edits it.
 *
 * A workspace never edits the shipped row. It writes its own, which shadows it — so the product
 * can ship a better entry later without overwriting what RFBT has learned, and a bad edit is
 * undone by deleting the workspace's copy rather than by remembering what the original said.
 * Same rule as trade cards and the glossary.
 *
 *   GET                          every entry, and the certificates nobody can explain yet
 *   POST { body, level, patch }  write this workspace's entry
 *   POST { kind: 'reset', … }    drop it and fall back to what we ship
 */
export async function GET() {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  if (!(await hasCertLibrary(db))) return NextResponse.json({ ready: false, entries: [], unknown: [] });

  const [{ data: entries }, { data: unknown }] = await Promise.all([
    db.from('cert_library').select('*').or(`workspace_id.is.null,workspace_id.eq.${me.workspace_id}`).order('body').order('level', { nullsFirst: true }),
    db.from('cert_unknown').select('*').eq('workspace_id', me.workspace_id).is('resolved_at', null).order('last_seen_at', { ascending: false }),
  ]);

  return NextResponse.json({ ready: true, entries: entries ?? [], unknown: unknown ?? [] });
}

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  if (me.role !== 'senior') return NextResponse.json({ error: 'Only a senior can edit the certificate library.' }, { status: 403 });

  const db = supabaseAdmin();
  if (!(await hasCertLibrary(db))) return NextResponse.json({ error: 'Migration 0019 has not been applied yet.' }, { status: 503 });

  try {
    const b = await req.json();
    const body = String(b.body ?? '').toLowerCase().trim();
    if (!body) return NextResponse.json({ error: 'body is required' }, { status: 400 });
    const level = b.level ? String(b.level) : null;

    if (b.kind === 'reset') {
      let q = db.from('cert_library').delete().eq('workspace_id', me.workspace_id).eq('body', body);
      q = level === null ? q.is('level', null) : q.eq('level', level);
      const { error } = await q;
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, reset: `${body}${level ? ' ' + level : ''}` });
    }

    if (!b.patch?.title || !b.patch?.meaning) {
      return NextResponse.json({ error: 'a title and a meaning are required — an entry that says nothing is worse than none' }, { status: 400 });
    }

    const { data, error } = await writeEntry(db, {
      workspaceId: me.workspace_id, body, level, userId: me.id,
      patch: {
        title: b.patch.title,
        meaning: b.patch.meaning,
        covers: b.patch.covers ?? null,
        not_covered: b.patch.not_covered ?? null,
        who_requires: b.patch.who_requires ?? null,
        typical_validity: b.patch.typical_validity ?? null,
        verification_route: b.patch.verification_route ?? null,
        trades: b.patch.trades ?? [],
        source: `written by ${me.name ?? me.email}`,
      },
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Adding the entry clears the task that asked for it. From now on every card and every
    // client pack explains this certificate.
    let clear = db.from('cert_unknown').update({ resolved_at: new Date().toISOString(), resolved_by: me.id })
      .eq('workspace_id', me.workspace_id).eq('body', body);
    clear = level === null ? clear : clear.eq('level', level);
    await clear;

    return NextResponse.json({ ok: true, entry: data });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
