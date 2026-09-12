import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { matchName, normName } from '@/lib/name-match';
import { hasAttachTrail, hasRightToWork } from '@/lib/schema-features';
import { isEea } from '@/lib/right-to-work';
export const maxDuration = 60;

/**
 * Put a document on the right person — a decision, made by a recruiter.
 *
 * Intake attaches by itself only on an exact name match. Everything else lands here, because
 * the alternative is a system that quietly decides "Paul Daniel Pascale" is the Paul Pascale in
 * the pool. Attaching a welder's ticket to the wrong welder puts an unqualified man on a plane,
 * so the near cases are offered and never taken.
 *
 * Three things it can do, all of them explicit:
 *
 *   GET  ?documentId=…            what this document is, and who it might belong to
 *   POST { documentId, candidateId }   attach to that person
 *   POST { documentId, create: true }  open a record for the person named on the document
 *
 * Creating from a certificate is allowed here and not on intake, and that is the point: intake
 * must not invent a person from a ticket, but a recruiter looking at the ticket may decide one
 * exists. The record is opened from what the document says and nothing else.
 */

export async function GET(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const id = new URL(req.url).searchParams.get('documentId');
  if (!id) return NextResponse.json({ error: 'documentId is required' }, { status: 400 });

  const db = supabaseAdmin();
  const { data: doc } = await db.from('documents').select('id, type, cert_body, extracted, candidate_id, workspace_id').eq('id', id).maybeSingle();
  if (!doc || doc.workspace_id !== me.workspace_id) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const { data: known } = await db.from('candidates').select('id, reference_code, full_name').eq('workspace_id', me.workspace_id);
  const holder = (doc.extracted as any)?.holder ?? null;
  return NextResponse.json({
    document: { id: doc.id, type: doc.type, cert_body: doc.cert_body, holder, attached: doc.candidate_id },
    suggestions: matchName(known ?? [], holder).slice(0, 5).map((m) => ({
      candidateId: m.candidate.id, reference: m.candidate.reference_code, name: m.candidate.full_name, kind: m.kind, why: m.why,
    })),
    candidates: (known ?? []).map((c) => ({ id: c.id, reference: c.reference_code, name: c.full_name })),
  });
}

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  try {
    const b = await req.json();
    const db = supabaseAdmin();
    const ids: string[] = b.documentIds ?? (b.documentId ? [b.documentId] : []);
    if (!ids.length) return NextResponse.json({ error: 'documentId is required' }, { status: 400 });

    const { data: docs } = await db.from('documents').select('id, type, cert_body, extracted, candidate_id, workspace_id').in('id', ids);
    const mine = (docs ?? []).filter((d) => d.workspace_id === me.workspace_id);
    if (!mine.length) return NextResponse.json({ error: 'not found' }, { status: 404 });

    let candidateId: string | null = b.candidateId ?? null;
    let created: any = null;

    // --- open a record from what the document says, when asked to.
    if (b.create) {
      const ext = (mine[0].extracted ?? {}) as any;
      const holder = String(ext.holder ?? '').trim();
      if (!holder) return NextResponse.json({ error: 'this document has no holder name on it, so there is nothing to open a record from' }, { status: 400 });

      // The trade is taken from the certificate body when that says one, and left unset when it
      // does not. A record that says "welder" because the file was in a folder called welders
      // is the fabrication this product exists to avoid.
      const tradeByBody: Record<string, { code: string; trade: string }> = {
        iso9606: { code: 'w', trade: 'Welder' },
        frosio: { code: 'p', trade: 'Surface treatment inspector' },
        ampp: { code: 'p', trade: 'Coating inspector' },
        pcn: { code: 'n', trade: 'NDT technician' },
        cswip: { code: 'w', trade: 'Welding inspector' },
        irata: { code: 'r', trade: 'Rope access technician' },
        cisrs: { code: 's', trade: 'Scaffolder' },
        winda: { code: 'e', trade: 'Wind technician' },
      };
      const guess = tradeByBody[String(mine[0].cert_body ?? '').toLowerCase()];
      // A CV that was held back for a name decision already carries a parsed profile. Use it —
      // opening the record from the certificate's thin guess when the whole CV is on file would
      // throw away everything the reading found.
      const cv = ext.profile && mine[0].type === 'cv' ? ext.profile : null;
      const tradeCode = cv?.trade_code ?? guess?.code ?? 'x';
      const code = (await db.rpc('next_reference_code', { tc: tradeCode })).data as string;
      const { data: row, error } = await db.from('candidates').insert({
        workspace_id: me.workspace_id,
        reference_code: code,
        trade_code: tradeCode,
        full_name: cv?.full_name ?? holder,
        trade: cv?.trade ?? guess?.trade ?? null,
        phone: cv?.pii?.phone ?? null,
        email: cv?.pii?.email ?? null,
        languages: cv?.languages ?? null,
        created_via: 'verify',
        created_by: me.id,
        profile: cv ?? { full_name: holder, opened_from: { document: mine[0].id, body: mine[0].cert_body ?? mine[0].type } },
      }).select().single();
      if (error) return NextResponse.json({ error: `could not open the record: ${error.message}` }, { status: 500 });
      created = row;
      candidateId = row.id;
    }

    if (!candidateId) return NextResponse.json({ error: 'candidateId is required, or create: true' }, { status: 400 });

    const { data: cand } = await db.from('candidates').select('id, reference_code, full_name, workspace_id').eq('id', candidateId).maybeSingle();
    if (!cand || cand.workspace_id !== me.workspace_id) return NextResponse.json({ error: 'no such candidate' }, { status: 404 });

    // The reason is stored, not the fact alone. Six months from now the question is not whether
    // someone attached it but why they thought it was the same person.
    const holder = (mine[0].extracted as any)?.holder ?? null;
    const exact = normName(holder) === normName(cand.full_name);
    const reason = b.reason ?? (b.create
      ? 'record opened from this document'
      : exact ? 'the name on the document matches the record' : `attached by ${me.name ?? me.email} — names differ (${holder ?? 'no holder on the document'} → ${cand.full_name ?? '—'})`);

    const trail = await hasAttachTrail(db);
    const patch: any = { candidate_id: candidateId };
    if (trail) { patch.attached_by = me.id; patch.attached_at = new Date().toISOString(); patch.attach_reason = reason.slice(0, 400); }
    const { error: upd } = await db.from('documents').update(patch).in('id', mine.map((d) => d.id));
    if (upd) return NextResponse.json({ error: upd.message }, { status: 500 });

    // A passport settles right to work, and it has to settle it here too — otherwise attaching
    // one by hand leaves the candidate looking unchecked when the evidence is on file.
    const passport = mine.find((d) => d.type === 'passport');
    if (passport && (await hasRightToWork(db))) {
      const ext = (passport.extracted ?? {}) as any;
      const issuer = String(ext.nationality ?? ext.country ?? '').toUpperCase().slice(0, 2);
      if (issuer.length === 2) {
        await db.from('candidates').update({
          nationality: issuer,
          eu_passport: isEea(issuer),
          eu_passport_source: 'passport',
          eu_passport_document_id: passport.id,
          ...(issuer === 'GB' ? { uk_right_to_work: true, uk_right_to_work_basis: 'citizen', uk_right_to_work_source: 'passport', uk_right_to_work_document_id: passport.id } : {}),
          right_to_work_checked_at: new Date().toISOString(),
        }).eq('id', candidateId);
      }
    }

    return NextResponse.json({
      ok: true,
      attached: mine.length,
      candidate: { id: cand.id, reference: cand.reference_code, name: cand.full_name },
      created: !!created,
      reason,
      trailStored: trail,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
