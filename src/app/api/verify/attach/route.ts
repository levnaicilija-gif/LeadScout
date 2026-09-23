import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { matchName, holderFits } from '@/lib/name-match';
import { hasAttachTrail, hasRightToWork, hasCandidateCrm } from '@/lib/schema-features';
import { nextReferenceCode } from '@/lib/reference-code';
import { isEea } from '@/lib/right-to-work';
import { allRows } from '@/lib/all-rows';
import { judgeDuplicate } from '@/lib/candidate-dedupe';
import { mergeFromCv, mergeNote } from '@/lib/cv-merge';
import { readPoolForMatching, POOL_UNREADABLE } from '@/lib/candidate-pool-read';
export const maxDuration = 60;

/**
 * Put a document on the right person — a decision, made by a recruiter.
 *
 * Intake attaches by itself only on an exact name match. Everything else lands here, because
 * the alternative is a system that quietly decides "Paul Daniel Pascale" is the Paul Pascale in
 * the pool. Attaching a welder's ticket to the wrong welder puts an unqualified man on a plane,
 * so the near cases are offered and never taken.
 *
 * Before a document goes on a chosen person, the name on it must fit theirs (holderFits). When it does not, the answer is
 * 409 with the two names, and the document is attached only when the call says it has seen that (confirmMismatch) — the
 * MismatchQuestion's "Attach anyway". Every way of attaching comes through here, so one check covers Verify's cards,
 * "Attach to someone else…" and a candidate page's question (item 24 follow-up, 2026-09-15).
 *
 * Three things it can do, all of them explicit:
 *
 *   GET  ?documentId=…            what this document is, and who it might belong to
 *   POST { documentId, candidateId, confirmMismatch? }   attach to that person
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

  const { data: known } = await allRows<{ id: string; reference_code: string; full_name: string }>((from, to) => db.from('candidates').select('id, reference_code, full_name').eq('workspace_id', me.workspace_id).order('id').range(from, to));
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

    const { data: docs } = await db.from('documents').select('id, type, cert_body, extracted, candidate_id, workspace_id, uploaded_at').in('id', ids);
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

      // WHO THIS WAS OPENED DESPITE. The recruiter reached this button from a card that already told
      // them somebody looks like a match — item 24's rule — and chose to open a record anyway, which
      // is a legitimate choice (two real people do share a name). But the record must carry why it
      // exists, the same way a document attached over a name mismatch says "attached anyway by X
      // after being told the names differ". Judged HERE, server side, against the pool as it stands:
      // the browser sends no verdict, so this cannot be spoofed or go stale between the card being
      // drawn and the button being pressed.
      const { known, error: poolError } = await readPoolForMatching(db, me.workspace_id);
      if (poolError) return NextResponse.json({ error: POOL_UNREADABLE, detail: poolError }, { status: 503 });
      const judged = judgeDuplicate(known, { full_name: holder, email: cv?.pii?.email, phone: cv?.pii?.phone, dob: cv?.pii?.dob });
      // Only the `ask` verdict carries matches — `create` means nobody looked like this person, and a
      // record opened then is an ordinary one with nothing to record.
      const despite = judged.verdict === 'ask'
        ? judged.matches.map((m) => ({ reference: m.candidate.reference_code, candidate_id: m.candidate.id, strength: m.strength, why: m.why }))
        : [];
      // Read the call's error, as intake does: a failed call made a reference-less candidate on 2026-09-15.
      const code = await nextReferenceCode(db, tradeCode);
      const crm = await hasCandidateCrm(db);
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
        profile: {
          ...(cv ?? { full_name: holder, opened_from: { document: mine[0].id, body: mine[0].cert_body ?? mine[0].type } }),
          ...(despite.length ? { opened_despite: { at: new Date().toISOString(), by: me.id, matches: despite } } : {}),
        },
        ...(crm ? { owner_id: me.id } : {}),
      }).select().single();
      if (error) return NextResponse.json({ error: `could not open the record: ${error.message}` }, { status: 500 });
      created = row;
      candidateId = row.id;
    }

    if (!candidateId) return NextResponse.json({ error: 'candidateId is required, or create: true' }, { status: 400 });

    const { data: cand } = await db.from('candidates').select('id, reference_code, full_name, workspace_id').eq('id', candidateId).maybeSingle();
    if (!cand || cand.workspace_id !== me.workspace_id) return NextResponse.json({ error: 'no such candidate' }, { status: 404 });

    if (!b.create && b.confirmMismatch !== true) {
      const misfit = mine.map((d) => ({ d, holder: holderOf(d), fit: holderFits(holderOf(d), cand.full_name) })).find((x) => !x.fit.fits);
      if (misfit) {
        return NextResponse.json({
          error: `the ${misfit.d.type} names ${misfit.holder ?? 'nobody'}, and this candidate is ${cand.full_name ?? 'unnamed'} — nothing was attached`,
          mismatch: { documentId: misfit.d.id, type: misfit.d.type, holder: misfit.holder, candidate: { id: cand.id, reference: cand.reference_code, name: cand.full_name ?? null }, why: misfit.fit.why },
        }, { status: 409 });
      }
    }

    // A CV attached to someone already in the pool brings its reading with it — when it is their newest CV. The profile
    // (what the client version, the search and the page read) follows the current CV, the newest by upload date, as Read CV
    // and Download original do; an older CV attached later is kept as history and changes nothing (owner's decision,
    // 2026-09-15: older CVs stay as history). Until then whichever CV was attached last became the profile, so a CV held
    // back for a decision could replace a newer reading. Intake asks before attaching since item 24, so this is where it lands.
    let merged: string | null = null;
    let conflicts: { field: string; current: unknown; fromCv: unknown }[] = [];
    const cvDoc = !b.create
      ? mine.filter((d) => d.type === 'cv' && (d.extracted as any)?.profile).sort((x, y) => String(y.uploaded_at).localeCompare(String(x.uploaded_at)))[0]
      : undefined;
    if (cvDoc) {
      const { data: newer, error: newerError } = await db.from('documents').select('id').eq('candidate_id', candidateId).eq('type', 'cv').gt('uploaded_at', cvDoc.uploaded_at).limit(1);
      if (newerError) return NextResponse.json({ error: `their CVs could not be compared, so nothing was attached: ${newerError.message}` }, { status: 500 });
      if (!(newer ?? []).length) {
        // The three-tier rule (cv-merge.ts), not a blanket overwrite: the reading always follows the
        // newest CV, an empty field is filled from it, and a field the recruiter already filled is
        // left alone with the disagreement reported. `isNewest` is already decided above — an older
        // CV never reaches here — so the merge is asked for the newest case only.
        const merge = mergeFromCv(cand, (cvDoc.extracted as any).profile, { isNewest: true });
        const { error: mergeError } = await db.from('candidates').update(merge.patch).eq('id', candidateId);
        if (mergeError) return NextResponse.json({ error: `the CV was attached but their record could not be updated: ${mergeError.message}` }, { status: 500 });
        merged = mergeNote(merge);
        conflicts = merge.conflicts;
      }
    }

    // The reason is stored, not the fact alone. Six months from now the question is not whether
    // someone attached it but why they thought it was the same person.
    const holder = holderOf(mine[0]);
    const reason = b.create
      ? (b.reason ?? 'record opened from this document')
      : !holderFits(holder, cand.full_name).fits
        ? `attached anyway by ${me.name ?? me.email} after being told the names differ (${holder ?? 'no name on the document'} → ${cand.full_name ?? '—'})${b.reason ? ` — ${b.reason}` : ''}`
        : (b.reason ?? 'the name on the document fits the record');

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
      // What the newer CV changed, and what it was NOT allowed to change. Returned so the card can
      // say so: an update that silently leaves a disagreement is how a recruiter comes to trust a
      // stale phone number.
      merged,
      conflicts,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}

/** The name a document carries: a certificate's holder, or the name read from a CV. */
function holderOf(d: any): string | null {
  return d?.extracted?.holder ?? d?.extracted?.profile?.full_name ?? null;
}
