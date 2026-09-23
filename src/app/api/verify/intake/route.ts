import { documentPath, newDocumentId } from '@/lib/storage-path';
import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { extractDocument, parseCv, anonymize, transcribeCv } from '@/lib/ai/documents';
import { meterRecruiter } from '@/lib/ai/meter';
import { nextReferenceCode } from '@/lib/reference-code';
import { fileToBase64 } from '@/lib/files';
import { appearsIn } from '@/lib/ai/claude';
import { isEea } from '@/lib/right-to-work';
import { countriesFromText, norm } from '@/lib/geo';
import { hasRightToWork, hasCandidateCrm, hasColumn } from '@/lib/schema-features';
import { contentHash, sameFileInWorkspace, sameFileNote } from '@/lib/document-hash';
import { mergeFromCv, mergeNote } from '@/lib/cv-merge';
import { judgeDuplicate } from '@/lib/candidate-dedupe';
import { matchName, autoMatch, normName, holderFits } from '@/lib/name-match';
import { readPoolForMatching, POOL_UNREADABLE } from '@/lib/candidate-pool-read';
export const maxDuration = 300;

/**
 * One drop zone for everything a candidate sends.
 *
 * Each file is recognised by its content, not by its name or the tab it was dropped on, and
 * then handled according to what it turned out to be. Results are grouped by candidate: a
 * document is attached to an existing candidate when the name on it matches one, and only a CV
 * may create a new candidate — a certificate alone tells us too little to open a record.
 *
 * A file we cannot recognise is NOT saved and never creates a candidate.
 *
 * This is step 1: recognise, store, attach. The slow follow-ups (register lookups, bullets,
 * PDFs) run as their own requests so nothing here approaches the function limit.
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
    if (!files.length) return NextResponse.json({ error: 'at least one file is required' }, { status: 400 });
    // Item 24: files dropped on a candidate's own page are meant for that candidate. They attach only when the name on them
    // fits the candidate's (holderFits); otherwise the file is stored unattached and the page asks — attach anyway, or open a
    // record for the person named. Until 2026-09-15 nothing asked, and Paul Daniel Pascale's certificate went onto #9.
    // Checked against the workspace before anything is stored.
    const targetId = String(form.get('candidate_id') ?? '').trim() || null;
    // The certificate-check screen (/app/certificate) drops here too, but it does exactly one thing: read a
    // certificate and check it with the issuer. No candidate is created and none is touched — not even the
    // exact-name attach below, which is right for Verify (a ticket arriving for someone already in the pool
    // belongs on them) and wrong here, where the recruiter asked a question about a document, not about a
    // person. The document is still stored, because a check that keeps no evidence cannot be re-read, and it
    // waits in Verify's "documents attached to nobody" panel to be attached deliberately later.
    const certificateOnly = String(form.get('mode') ?? '') === 'certificate_only';

    const db = supabaseAdmin();
    const results: any[] = [];
    // Right to work is stored by migration 0013; until it is applied the rest of intake still works.
    const rtwReady = await hasRightToWork(db);

    // Candidates already in the workspace, for matching a document to a person — by name, and for a CV by a second field
    // too (email, phone, date of birth; item 24).
    //
    // THE ERROR IS READ, and a failure refuses the whole request rather than continuing with an empty
    // pool. Until 2026-09-23 this dropped `{ error }`, so a read that failed produced `known = []` —
    // and an empty pool does not mean "nobody matches", it means "I could not look". judgeDuplicate
    // then found nothing to compare against and the CV opened a SECOND RECORD for somebody already on
    // file, silently. That is how RFBT-P-0625 and RFBT-P-0626 came to be the same person, the same CV
    // byte for byte, 85 seconds apart. Nothing is stored here on a guess: a document the recruiter
    // still has is recoverable, a duplicate person record is not.
    const { known, error: poolError } = await readPoolForMatching(db, me.workspace_id);
    if (poolError) return NextResponse.json({ error: POOL_UNREADABLE, detail: poolError }, { status: 503 });
    const touched = new Map<string, any>();
    const target = targetId ? known.find((c) => c.id === targetId) : null;
    if (targetId && !target) return NextResponse.json({ error: 'no such candidate in your workspace' }, { status: 404 });

    for (const f of files) {
      const row: any = { file: f.name };
      try {
        const bytes = Buffer.from(await f.arrayBuffer());
        const prepared = await fileToBase64(bytes, f.type, f.name);
        if (prepared.kind === 'unsupported') { row.kind = 'unreadable'; row.why = 'unsupported file type — use PDF, DOCX or a photo'; results.push(row); continue; }

        const text = prepared.kind === 'text' ? prepared.text! : '';
        const ext = await extractDocument(prepared.base64, prepared.mediaType);
        row.extracted = ext;
        row.kind = ext.doc_type;

        // The holder must actually be on the page. A model that shortens "Marian Marcu" to
        // "M. Marcu" has stopped copying and started guessing.
        const source = text || JSON.stringify(ext);
        if (ext.holder && text && !appearsIn(text, ext.holder)) { delete (ext as any).holder; row.holderDropped = true; }

        if (ext.doc_type === 'other') {
          row.kind = 'other';
          row.why = 'not a candidate document';
          results.push(row);                                  // deliberately not saved
          continue;
        }

        // Certificate-check screen: anything that is not a certificate is refused and NOT stored. The judgement
        // is extractDocument's own doc_type, the same classifier Verify uses — never the file name, never a list
        // written here that would drift from it. A CV dropped on this screen therefore cannot create a candidate,
        // because it never reaches the branch that would.
        if (certificateOnly && ext.doc_type !== 'certificate') {
          row.kind = 'refused';
          row.why = `this screen checks certificates only — that file was read as a ${ext.doc_type.replace('_', ' ')}. Drop it into Verify, which takes every kind.`;
          results.push(row);                                  // deliberately not saved
          continue;
        }

        // ---- CV: the only document that may create a candidate.
        if (ext.doc_type === 'cv') {
          const cvText = prepared.kind === 'text' ? prepared.text! : await transcribeCv(prepared.base64, prepared.mediaType);
          if (!cvText.trim()) { row.kind = 'unreadable'; row.why = 'no readable text in the file'; results.push(row); continue; }
          const profile = await parseCv(cvText);
          // Dropped on a candidate's page: it is their CV. It refreshes their reading, as attaching a CV does, and says so
          // when the name on it is not theirs.
          if (target) {
            const fit = holderFits(profile.full_name, target.full_name);
            if (!fit.fits) {
              // Someone else's CV by the name on it: stored unattached, their profile untouched, and the page asks.
              const doc = await store(db, me, bytes, f, 'cv', null, { text: cvText.slice(0, 5000), profile, holder: profile.full_name });
              row.documentId = doc?.id ?? null;
              row.mismatch = mismatchFor(target, profile.full_name, fit.why, 'cv');
              row.profile = anonymize(profile); row.trade = profile.trade;
              results.push(row);
              continue;
            }
            // Item 24's update path, under the three-tier rule (cv-merge.ts): the reading is always
            // replaced, an empty field is filled from the CV, and a field the recruiter already
            // filled is LEFT ALONE with the disagreement reported. This used to overwrite trade and
            // languages outright whenever the CV stated them, so a trade somebody had refined by
            // hand went back to whatever the parser said on the next upload.
            const merge = mergeFromCv(target, profile);
            const { error: mergeError } = await db.from('candidates').update(merge.patch).eq('id', target.id);
            if (mergeError) { row.kind = 'unreadable'; row.why = `could not update the candidate: ${mergeError.message}`; results.push(row); continue; }
            row.merged = mergeNote(merge);
            row.conflicts = merge.conflicts;
            await store(db, me, bytes, f, 'cv', target.id, { text: cvText.slice(0, 5000), profile, holder: profile.full_name });
            row.candidateId = target.id; row.reference = target.reference_code; row.profile = anonymize(profile); row.trade = profile.trade;
            touched.set(target.id, target);
            results.push(row);
            continue;
          }
          // Is this someone already in the pool? Item 24 uses the rule proven on the WindEurope imports — a name plus a
          // second field (email, phone, date of birth), never the name alone (src/lib/candidate-dedupe.ts). Until
          // 2026-09-15 an exact name was enough and the CV silently rewrote that candidate's profile, so two welders
          // called Lars Nilsen would have become one. A likely or name-only match is stored and asked about — nothing is
          // created or changed until a recruiter chooses; no match, or a namesake whose details all differ, is a new record.
          // 0044: THE SAME FILE, BYTE FOR BYTE. Checked before the name rule because it is the one
          // signal with no judgement in it — not "these look alike" but "you already have this".
          // RFBT-P-0625 and RFBT-P-0626 are the same 84,293 bytes, and nothing could see it: the
          // digest in a storage path is of the FILE NAME, never of the content.
          //
          // It is NOT stored again. The bytes are already in this workspace, on somebody, so a second
          // copy would add a duplicate document to answer a duplicate record — the clutter this item
          // exists to stop, one level down. The message says who holds it, which is what a recruiter
          // needs to act. An error from the lookup is surfaced, never read as "no duplicate".
          const hash = contentHash(bytes);
          const seen = await sameFileInWorkspace(db, me.workspace_id, hash);
          if (seen.error) { row.kind = 'unreadable'; row.why = `could not check whether this file is already on file: ${seen.error}`; results.push(row); continue; }
          const already = seen.supported ? sameFileNote(seen.matches) : null;
          if (already) {
            row.sameFile = already;
            row.needsDecision = `${already} Nothing has been created or stored again — open that record if this CV belongs there, or drop it on the right person's page.`;
            row.suggest = seen.matches.filter((m) => m.candidateId).slice(0, 4).map((m) => ({ candidateId: m.candidateId, reference: m.reference, name: m.name, kind: 'same_file', why: 'the same file, byte for byte' }));
            row.profile = anonymize(profile);
            row.trade = profile.trade;
            results.push(row);
            continue;
          }

          const judged = judgeDuplicate(known, { full_name: profile.full_name, email: profile.pii.email, phone: profile.pii.phone, dob: profile.pii.dob });
          if (judged.verdict === 'ask') {
            const doc = await store(db, me, bytes, f, 'cv', null, { text: cvText.slice(0, 5000), profile, holder: profile.full_name });
            row.documentId = doc?.id ?? null;
            row.needsDecision = judged.matches[0].strength === 'likely'
              ? 'This looks like someone already in the pool — nothing is created or changed until you choose.'
              : 'Someone with this name is already in the pool, and nothing else on either record can be compared — nothing is created until you choose.';
            row.suggest = judged.matches.slice(0, 4).map((m) => ({ candidateId: m.candidate.id, reference: m.candidate.reference_code, name: m.candidate.full_name, kind: m.strength, why: m.why }));
            row.profile = anonymize(profile);
            row.trade = profile.trade;
            results.push(row);
            continue;
          }
          if (judged.namesakes.length) row.namesakeNote = judged.why;

          const code = await nextReferenceCode(db, profile.trade_code);
          const crm = await hasCandidateCrm(db);
          const { data: created, error } = await db.from('candidates').insert({
            workspace_id: me.workspace_id, reference_code: code, trade_code: profile.trade_code,
            full_name: profile.full_name, phone: profile.pii.phone, email: profile.pii.email,
            trade: profile.trade, languages: profile.languages, profile, created_via: 'verify', created_by: me.id,
            ...(crm ? { owner_id: me.id } : {}),
          }).select().single();
          if (error) { row.kind = 'unreadable'; row.why = `could not create the candidate: ${error.message}`; results.push(row); continue; }
          const person = { ...created, key: normName(created.full_name), dob: profile.pii.dob ?? null };
          known.push(person);

          // What the CV says about right to work — recorded as "per CV" so a passport can
          // overwrite it later, and never allowed to overwrite a passport that already has.
          const said: any = {};
          if (profile.nationality) said.nationality = String(profile.nationality).toUpperCase().slice(0, 2);
          if (profile.eu_passport !== undefined) { said.eu_passport = profile.eu_passport; said.eu_passport_source = 'cv'; }
          if (profile.uk_right_to_work !== undefined) { said.uk_right_to_work = profile.uk_right_to_work; said.uk_right_to_work_source = 'cv'; }
          if (profile.uk_right_to_work_basis) said.uk_right_to_work_basis = profile.uk_right_to_work_basis;
          if (rtwReady && Object.keys(said).length) {
            const { data: cur } = await db.from('candidates').select('eu_passport_source, uk_right_to_work_source').eq('id', person.id).maybeSingle();
            if (cur?.eu_passport_source === 'passport') { delete said.eu_passport; delete said.eu_passport_source; delete said.nationality; }
            if (cur?.uk_right_to_work_source === 'passport') { delete said.uk_right_to_work; delete said.uk_right_to_work_source; delete said.uk_right_to_work_basis; }
            if (Object.keys(said).length) await db.from('candidates').update({ ...said, right_to_work_checked_at: new Date().toISOString() }).eq('id', person.id);
          }
          await store(db, me, bytes, f, 'cv', person.id, { text: cvText.slice(0, 5000), profile, holder: profile.full_name });
          row.candidateId = person.id; row.reference = person.reference_code;
          row.profile = anonymize(profile);
          row.trade = profile.trade;
          touched.set(person.id, person);
          results.push(row);
          continue;
        }

        // ---- Everything else attaches to a candidate when the name matches one exactly.
        //
        // When it does not, the document is still stored — it is a real document about a real
        // person — and the card offers the near matches, or offers to open a record from it.
        // A certificate never opens one by itself: a ticket says what someone can do, not that
        // we have them. That is a recruiter's call, taken on the card.
        // Dropped on a candidate's page, it goes on them only when the name on it fits theirs; otherwise it is stored
        // unattached and the page asks. Anywhere else, only an exact name match attaches by itself.
        const fit = target ? holderFits(ext.holder, target.full_name) : null;
        const cand = certificateOnly ? null : target ? (fit!.fits ? target : null) : autoMatch(known, ext.holder);
        if (target && !fit!.fits) row.mismatch = mismatchFor(target, ext.holder, fit!.why, ext.doc_type);
        const doc = await store(db, me, bytes, f, ext.doc_type, cand?.id ?? null, ext);
        row.documentId = doc?.id ?? null;
        row.candidateId = cand?.id ?? null;
        row.reference = cand?.reference_code ?? null;
        if (!cand && !row.mismatch) {
          row.suggest = matchName(known, ext.holder).slice(0, 4).map((m) => ({ candidateId: m.candidate.id, reference: m.candidate.reference_code, name: m.candidate.full_name, kind: m.kind, why: m.why }));
          row.needsDecision = ext.holder
            ? (row.suggest.length ? 'Nobody in the pool has exactly this name.' : `Nobody in the pool is called ${ext.holder}.`)
            : 'No holder name could be read from this document.';
        }

        if (ext.doc_type === 'contract' && cand) {
          // Availability follows the contract: free the day after it ends.
          const end = parseDate(ext.end);
          const availability = end ? new Date(end.getTime() + 86400000).toISOString().slice(0, 10) : null;
          await db.from('candidates').update({
            ...(availability ? { availability_from: availability } : {}),
            // Employer and site are internal only — they never reach the anonymised profile.
            current_employer: ext.employer ?? null,
            current_site: ext.workplace ?? null,
            contract_end: end ? end.toISOString().slice(0, 10) : null,
          }).eq('id', cand.id);
          row.availabilitySet = availability;
          row.employer = ext.employer; row.site = ext.workplace; row.until = ext.end;
        }

        if (ext.doc_type === 'passport' && cand) {
          // Name cross-check against the certificates already on file.
          const { data: certs } = await db.from('documents').select('extracted').eq('candidate_id', cand.id).eq('type', 'certificate');
          const names = (certs ?? []).map((c: any) => c.extracted?.holder).filter(Boolean);
          row.nameMatches = names.length === 0 ? null : names.every((n: string) => normName(n) === normName(ext.holder));
          row.checkedAgainst = names.length;

          // A passport is the evidence for right to work, so it settles it — with the document
          // recorded, because "EU passport: yes" with nothing behind it is exactly the kind of
          // claim this system exists to avoid.
          const issuer = passportCountry(ext);
          if (rtwReady && issuer) {
            const eu = isEea(issuer);
            await db.from('candidates').update({
              nationality: issuer,
              eu_passport: eu,
              eu_passport_source: 'passport',
              eu_passport_document_id: doc?.id ?? null,
              // A British passport is UK right to work; nothing else about the UK follows.
              ...(issuer === 'GB' ? { uk_right_to_work: true, uk_right_to_work_basis: 'citizen', uk_right_to_work_source: 'passport', uk_right_to_work_document_id: doc?.id ?? null } : {}),
              right_to_work_checked_at: new Date().toISOString(),
            }).eq('id', cand.id);
            row.nationality = issuer;
            row.euPassport = eu;
            row.rightToWorkNote = eu
              ? `${issuer} passport — EU/EEA right to work confirmed from the document.`
              : `${issuer} passport — not EU/EEA. A work permit would be needed for EU sites.`;
          }
        }

        if (cand) touched.set(cand.id, cand);
        results.push(row);
      } catch (e: any) {
        // A CV that was recognised and then failed — parseCv threw, the candidate was never
        // created — used to keep kind 'cv' and render as a blank card with no reference and no
        // error anywhere. Whatever it was, it failed, and the card must say so.
        row.failed = true;
        row.why = String(e?.message ?? e).slice(0, 300);
        if (row.kind !== 'cv') row.kind = 'unreadable';
        results.push(row);
      }
    }

    // Group for the UI: one block per candidate, plus anything that belongs to nobody.
    const candidates = [...touched.values()].map((c) => ({
      id: c.id, reference_code: c.reference_code, full_name: c.full_name,
      files: results.filter((r) => r.candidateId === c.id),
    }));
    const loose = results.filter((r) => !r.candidateId);

    return NextResponse.json({
      files: results.length,
      candidates,
      loose,
      saved: results.filter((r) => r.kind !== 'other' && r.kind !== 'unreadable').length,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}

/**
 * The country that issued a passport, from whatever the extraction managed to read.
 *
 * Only from the document: the issuer line, or a nationality printed on it. Never from where the
 * holder has worked, and never guessed from a name.
 */
function passportCountry(ext: any): string | undefined {
  const direct = norm(ext?.nationality ?? ext?.country ?? '');
  if (direct.length === 2) return direct;
  const text = [ext?.issuer, ext?.scope, ext?.nationality, ext?.country].filter(Boolean).join(' ');
  return countriesFromText(text)[0];
}


function parseDate(s?: string | null) {
  if (!s) return null;
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(`${iso[0]}T00:00:00Z`);
  const uk = s.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (uk) return new Date(Date.UTC(+uk[3], +uk[2] - 1, +uk[1]));
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

/** What a candidate's page asks when a file dropped on it names someone else (MismatchQuestion). */
function mismatchFor(target: any, holder: string | null | undefined, why: string, type: string) {
  return { holder: holder ?? null, candidate: { id: target.id, reference: target.reference_code, name: target.full_name ?? null }, why, type };
}

async function store(db: any, me: any, bytes: Buffer, f: File, type: string, candidateId: string | null, extracted: any) {
  // The id is made HERE and used for both the object and the row, so the path is unique by
  // construction and nothing has to be inserted before the upload. `upsert: true` is kept — it is
  // now harmless, because no other document can ever resolve to this key — and it still makes a
  // retry of this same call idempotent rather than a duplicate object.
  const id = newDocumentId();
  const path = documentPath({ workspaceId: me.workspace_id, type, documentId: id, filename: f.name, contentType: f.type, candidateId });
  const up = await db.storage.from('documents').upload(path, bytes, { contentType: f.type || 'application/octet-stream', upsert: true });
  if (up.error) throw new Error(`could not store the file: ${up.error.message}`);
  // 0044: the hash of the bytes, so "the same file again" is answerable at all. Guarded, because a
  // deploy can land before its migration — a named column that is not there fails the WHOLE insert,
  // which would take Verify's drop zone down rather than lose one duplicate check.
  const hashed = await hasColumn(db, 'documents', 'content_sha256');
  const { data, error } = await db.from('documents').insert({
    id, workspace_id: me.workspace_id, candidate_id: candidateId, type, cert_body: extracted?.cert_body ?? null,
    storage_path: path, extracted, uploaded_by: me.id,
    ...(hashed ? { content_sha256: contentHash(bytes) } : {}),
    status: extracted?.unreadable?.length ? 'needs_retake' : 'received',
  }).select().single();
  if (error) throw new Error(`could not save the document: ${error.message}`);
  return data;
}
