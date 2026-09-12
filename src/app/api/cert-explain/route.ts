import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { explainCert } from '@/lib/certs/explain';
import { loadLibrary, noteUnknown } from '@/lib/certs/library';
import { hasCertLibrary } from '@/lib/schema-features';
export const maxDuration = 30;

/**
 * Explain a certificate. Tables and decoders only — no model call.
 *
 * A certificate nothing can explain is recorded as a task for a senior, once per body and
 * level however many copies arrive, and comes back marked unrecognised so the card can say so
 * instead of showing an empty space that reads like an answer.
 */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  try {
    const b = await req.json();
    const items: any[] = Array.isArray(b.items) ? b.items : [b];
    const db = supabaseAdmin();

    // The library arrives with 0019. Without it the code tables still explain everything they
    // know — a certificate does not become unreadable because a migration is late.
    const ready = await hasCertLibrary(db);
    const library = ready ? await loadLibrary(db, me.workspace_id, items.map((i) => i.body)) : [];

    const out = [];
    for (const i of items) {
      const e = explainCert({ body: i.body, level: i.level, scope: i.scope, position: i.position, process: i.process, library });
      if (!e.recognised && ready && i.body) {
        await noteUnknown(db, { workspaceId: me.workspace_id, body: i.body, level: i.level ?? null, documentId: i.documentId ?? null });
      }
      out.push({ ...e, documentId: i.documentId ?? null });
    }

    return NextResponse.json({ explanations: out, libraryReady: ready });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
