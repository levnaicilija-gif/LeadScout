import { documentPath, newDocumentId } from '@/lib/storage-path';
import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { parseCv, anonymize, transcribeCv } from '@/lib/ai/documents';
import { meterRecruiter } from '@/lib/ai/meter';
import { nextReferenceCode } from '@/lib/reference-code';
import { fileToBase64 } from '@/lib/files';
import { judgeDuplicate } from '@/lib/candidate-dedupe';
import { readPoolForMatching, POOL_UNREADABLE } from '@/lib/candidate-pool-read';
export const maxDuration = 120;

/**
 * STEP 1 of the CV anonymizer: read each CV, create the candidate, store the file.
 *
 * Bullets, job scoring, the PII review and the client PDF used to run in this same request.
 * For several CVs that is a dozen model calls plus a PDF render in one call, and it timed out
 * with no way for the recruiter to know. They now happen per candidate in
 * /api/anonymize/enrich, so this returns as soon as the CVs are read.
 */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  // Item 16: every model call below is logged against this workspace, and never stopped by the daily cap.
  return meterRecruiter(me, () => handle(req, me));
}

type SignedIn = NonNullable<Awaited<ReturnType<typeof currentUser>>>;
async function handle(req: Request, me: SignedIn) {

  try {
    const form = await req.formData();
    const files = form.getAll('files') as File[];
    if (!files.length) return NextResponse.json({ error: 'at least one CV is required' }, { status: 400 });

    const db = supabaseAdmin();
    const results: any[] = [];
    const failed: { file: string; why: string }[] = [];

    // THIS ROUTE CREATED A CANDIDATE FROM EVERY CV WITH NO DUPLICATE CHECK AT ALL (found 2026-09-23).
    // Not a failed check — no check: it never read the pool, so there was nothing to fail. Verify's
    // intake has had item 24's rule since 2026-09-15 and this path never got it, which is the more
    // dangerous half of the same bug: intake could be fooled by a failed read, this one could not be
    // fooled because it never looked. Nothing in src/ or scripts/ calls it any more — Verify's intake
    // superseded it — but it is still a live endpoint any signed-in user can post to, so it is made
    // safe here rather than left as a hole behind a route nobody reads. Retiring it outright is a
    // separate decision, flagged rather than taken.
    const { known, error: poolError } = await readPoolForMatching(db, me.workspace_id);
    if (poolError) return NextResponse.json({ error: POOL_UNREADABLE, detail: poolError }, { status: 503 });

    for (const f of files) {
      try {
        const bytes = Buffer.from(await f.arrayBuffer());
        const prepared = await fileToBase64(bytes, f.type, f.name);
        if (prepared.kind === 'unsupported') { failed.push({ file: f.name, why: 'unsupported file type — use PDF, DOCX, an image or text' }); continue; }

        const text = prepared.kind === 'text' ? prepared.text! : await transcribeCv(prepared.base64, prepared.mediaType);
        if (!text.trim()) { failed.push({ file: f.name, why: 'no readable text in the file' }); continue; }

        const profile = await parseCv(text);

        // The same rule intake uses, from the same function — a name PLUS a second field, never the
        // name alone. A likely or name-only match is not created here: this route has no screen to
        // ask on, so the only honest answer is to refuse and name who it collided with.
        const judged = judgeDuplicate(known, { full_name: profile.full_name, email: profile.pii.email, phone: profile.pii.phone, dob: profile.pii.dob });
        if (judged.verdict === 'ask') {
          const m = judged.matches[0];
          failed.push({ file: f.name, why: `this looks like ${m.candidate.reference_code ?? 'somebody already on file'} — ${m.why}. Drop it on Verify, which can ask and attach it.` });
          continue;
        }

        const anon = anonymize(profile);
        const code = await nextReferenceCode(db, profile.trade_code);

        const { data: cand, error: cErr } = await db.from('candidates').insert({
          workspace_id: me.workspace_id, reference_code: code, trade_code: profile.trade_code,
          full_name: profile.full_name, phone: profile.pii.phone, email: profile.pii.email,
          trade: profile.trade, languages: profile.languages, profile, created_via: 'verify', created_by: me.id,
        }).select().single();
        if (cErr) { failed.push({ file: f.name, why: `could not create the candidate: ${cErr.code} ${cErr.message}` }); continue; }

        // The id is made here and used for both the object and the row: the path is unique per
        // DOCUMENT, so two different files of the same name can never overwrite each other.
        const docId = newDocumentId();
        const path = documentPath({ workspaceId: me.workspace_id, type: 'cv', documentId: docId, filename: f.name, contentType: f.type, candidateId: cand.id });
        const up = await db.storage.from('documents').upload(path, bytes, { contentType: f.type || 'application/octet-stream', upsert: true });
        if (up.error) { failed.push({ file: f.name, why: `could not store the file: ${up.error.message}` }); continue; }
        await db.from('documents').insert({
          id: docId, workspace_id: me.workspace_id, candidate_id: cand.id, type: 'cv', storage_path: path,
          extracted: { text: text.slice(0, 5000) }, uploaded_by: me.id,
        });

        results.push({
          candidate: { id: cand.id, reference_code: code },
          profile: anon,
          removed: ['name', 'phone', 'email', 'address', 'photo', 'date of birth', 'employer names'],
          crossCheck: { claimed: profile.certificates_claimed, verified: 0 },
          file: f.name,
        });
      } catch (e: any) {
        failed.push({ file: f.name, why: String(e?.message ?? e).slice(0, 200) });
      }
    }

    return NextResponse.json({ results, failed, next: results.length ? 'enrich' : null });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
