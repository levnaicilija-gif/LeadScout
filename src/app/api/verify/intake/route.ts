import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { extractDocument, parseCv, anonymize } from '@/lib/ai/documents';
import { claude, MODEL_EXTRACT } from '@/lib/ai/claude';
import { fileToBase64 } from '@/lib/files';
import { appearsIn } from '@/lib/ai/claude';
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
          let cand = matchCandidate(known, profile.full_name);
          if (!cand) {
            const code = (await db.rpc('next_reference_code', { tc: profile.trade_code })).data as string;
            const { data: created, error } = await db.from('candidates').insert({
              workspace_id: me.workspace_id, reference_code: code, trade_code: profile.trade_code,
              full_name: profile.full_name, phone: profile.pii.phone, email: profile.pii.email,
              trade: profile.trade, languages: profile.languages, profile, created_via: 'verify', created_by: me.id,
            }).select().single();
            if (error) { row.kind = 'unreadable'; row.why = `could not create the candidate: ${error.message}`; results.push(row); continue; }
            cand = { ...created, key: normName(created.full_name) };
            known.push(cand);
          } else {
            await db.from('candidates').update({ profile, trade: profile.trade, languages: profile.languages }).eq('id', cand.id);
            cand.profile = profile;
          }
          await store(db, me, bytes, f, 'cv', cand.id, { text: cvText.slice(0, 5000) });
          row.candidateId = cand.id; row.reference = cand.reference_code;
          row.profile = anonymize(profile);
          row.trade = profile.trade;
          touched.set(cand.id, cand);
          results.push(row);
          continue;
        }

        // ---- Everything else attaches to a candidate when the name matches one.
        const cand = matchCandidate(known, ext.holder);
        const doc = await store(db, me, bytes, f, ext.doc_type, cand?.id ?? null, ext);
        row.documentId = doc?.id ?? null;
        row.candidateId = cand?.id ?? null;
        row.reference = cand?.reference_code ?? null;

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
        }

        if (cand) touched.set(cand.id, cand);
        results.push(row);
      } catch (e: any) {
        row.kind = row.kind ?? 'unreadable';
        row.why = String(e?.message ?? e).slice(0, 200);
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

const normName = (n?: string | null) => (n ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

/** Same person, allowing for word order and a missing middle name. */
function matchCandidate(known: any[], name?: string | null) {
  const k = normName(name);
  if (!k || k.split(' ').length < 2) return undefined;
  const parts = k.split(' ');
  return known.find((c) => {
    if (!c.key) return false;
    if (c.key === k) return true;
    const cp = c.key.split(' ');
    // First and last name both present, in either order.
    return parts[0] && parts[parts.length - 1] && cp.includes(parts[0]) && cp.includes(parts[parts.length - 1]);
  });
}

function parseDate(s?: string | null) {
  if (!s) return null;
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(`${iso[0]}T00:00:00Z`);
  const uk = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (uk) return new Date(Date.UTC(+uk[3], +uk[2] - 1, +uk[1]));
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

async function store(db: any, me: any, bytes: Buffer, f: File, type: string, candidateId: string | null, extracted: any) {
  const path = `${me.workspace_id}/${type}/${Date.now()}-${f.name.replace(/[^\w.-]/g, '_')}`;
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
