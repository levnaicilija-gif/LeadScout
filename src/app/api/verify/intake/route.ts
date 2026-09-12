import { documentPath } from '@/lib/storage-path';
import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { extractDocument, parseCv, anonymize } from '@/lib/ai/documents';
import { claude, MODEL_EXTRACT } from '@/lib/ai/claude';
import { fileToBase64 } from '@/lib/files';
import { appearsIn } from '@/lib/ai/claude';
import { isEea } from '@/lib/right-to-work';
import { countriesFromText, norm } from '@/lib/geo';
import { hasRightToWork } from '@/lib/schema-features';
import { matchName, autoMatch, normName } from '@/lib/name-match';
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

  try {
    const form = await req.formData();
    const files = form.getAll('files') as File[];
    if (!files.length) return NextResponse.json({ error: 'at least one file is required' }, { status: 400 });

    const db = supabaseAdmin();
    const results: any[] = [];
    // Right to work is stored by migration 0013; until it is applied the rest of intake still works.
    const rtwReady = await hasRightToWork(db);

    // Candidates already in the workspace, for matching a document to a person by name.
    const { data: existing } = await db.from('candidates').select('id, reference_code, full_name, profile, availability_from').eq('workspace_id', me.workspace_id);
    const known = (existing ?? []).map((c) => ({ ...c, key: normName(c.full_name) }));
    const touched = new Map<string, any>();

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

        // ---- CV: the only document that may create a candidate.
        if (ext.doc_type === 'cv') {
          const cvText = prepared.kind === 'text' ? prepared.text! : await transcribe(prepared.base64, prepared.mediaType);
          if (!cvText.trim()) { row.kind = 'unreadable'; row.why = 'no readable text in the file'; results.push(row); continue; }
          const profile = await parseCv(cvText);
          let cand = autoMatch(known, profile.full_name);

          // A near match is not acted on. "M. Marcu" on file and "Marian Marcu" on the CV are
          // probably one man, and creating a second record is how the pool ended up with five
          // Marians — but so is attaching them when they are two. The file is stored, the card
          // asks, and nothing is created until someone answers.
          const near = cand ? [] : matchName(known, profile.full_name).filter((m) => m.kind === 'near');
          if (!cand && near.length) {
            const doc = await store(db, me, bytes, f, 'cv', null, { text: cvText.slice(0, 5000), profile, holder: profile.full_name });
            row.documentId = doc?.id ?? null;
            row.needsDecision = 'A candidate with a very similar name is already in the pool.';
            row.suggest = near.slice(0, 4).map((m) => ({ candidateId: m.candidate.id, reference: m.candidate.reference_code, name: m.candidate.full_name, kind: m.kind, why: m.why }));
            row.profile = anonymize(profile);
            row.trade = profile.trade;
            results.push(row);
            continue;
          }

          if (!cand) {
            const code = (await db.rpc('next_reference_code', { tc: profile.trade_code })).data as string;
            const { data: created, error } = await db.from('candidates').insert({
              workspace_id: me.workspace_id, reference_code: code, trade_code: profile.trade_code,
              full_name: profile.full_name, phone: profile.pii.phone, email: profile.pii.email,
              trade: profile.trade, languages: profile.languages, profile, created_via: 'verify', created_by: me.id,
            }).select().single();
            if (error) { row.kind = 'unreadable'; row.why = `could not create the candidate: ${error.message}`; results.push(row); continue; }
            cand = { ...created, key: normName(created.full_name) };
            known.push(cand!);
          } else {
            await db.from('candidates').update({ profile, trade: profile.trade, languages: profile.languages }).eq('id', cand.id);
            cand.profile = profile;
          }
          const person = cand!;

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
        const cand = autoMatch(known, ext.holder);
        const doc = await store(db, me, bytes, f, ext.doc_type, cand?.id ?? null, ext);
        row.documentId = doc?.id ?? null;
        row.candidateId = cand?.id ?? null;
        row.reference = cand?.reference_code ?? null;
        if (!cand) {
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

async function store(db: any, me: any, bytes: Buffer, f: File, type: string, candidateId: string | null, extracted: any) {
  const path = documentPath({ workspaceId: me.workspace_id, type, filename: f.name, contentType: f.type, candidateId });
  const up = await db.storage.from('documents').upload(path, bytes, { contentType: f.type || 'application/octet-stream', upsert: true });
  if (up.error) throw new Error(`could not store the file: ${up.error.message}`);
  const { data, error } = await db.from('documents').insert({
    workspace_id: me.workspace_id, candidate_id: candidateId, type, cert_body: extracted?.cert_body ?? null,
    storage_path: path, extracted, uploaded_by: me.id,
    status: extracted?.unreadable?.length ? 'needs_retake' : 'received',
  }).select().single();
  if (error) throw new Error(`could not save the document: ${error.message}`);
  return data;
}

async function transcribe(base64: string, mediaType: string) {
  const r = await claude.messages.create({
    model: MODEL_EXTRACT, max_tokens: 4000,
    messages: [{ role: 'user', content: [{ type: mediaType === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: mediaType as any, data: base64 } } as any, { type: 'text', text: 'Transcribe this CV as plain text, preserving structure. Output text only.' }] }],
  });
  return r.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');
}
