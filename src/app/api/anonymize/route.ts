import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { parseCv, anonymize } from '@/lib/ai/documents';
import { claude, MODEL_EXTRACT } from '@/lib/ai/claude';
import { fileToBase64 } from '@/lib/files';
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

  try {
    const form = await req.formData();
    const files = form.getAll('files') as File[];
    if (!files.length) return NextResponse.json({ error: 'at least one CV is required' }, { status: 400 });

    const db = supabaseAdmin();
    const results: any[] = [];
    const failed: { file: string; why: string }[] = [];

    for (const f of files) {
      try {
        const bytes = Buffer.from(await f.arrayBuffer());
        const prepared = await fileToBase64(bytes, f.type, f.name);
        if (prepared.kind === 'unsupported') { failed.push({ file: f.name, why: 'unsupported file type — use PDF, DOCX, an image or text' }); continue; }

        const text = prepared.kind === 'text' ? prepared.text! : await transcribe(prepared.base64, prepared.mediaType);
        if (!text.trim()) { failed.push({ file: f.name, why: 'no readable text in the file' }); continue; }

        const profile = await parseCv(text);
        const anon = anonymize(profile);
        const code = (await db.rpc('next_reference_code', { tc: profile.trade_code })).data as string;

        const { data: cand, error: cErr } = await db.from('candidates').insert({
          workspace_id: me.workspace_id, reference_code: code, trade_code: profile.trade_code,
          full_name: profile.full_name, phone: profile.pii.phone, email: profile.pii.email,
          trade: profile.trade, languages: profile.languages, profile, created_via: 'verify', created_by: me.id,
        }).select().single();
        if (cErr) { failed.push({ file: f.name, why: `could not create the candidate: ${cErr.code} ${cErr.message}` }); continue; }

        const path = `${me.workspace_id}/cv/${cand.id}-${f.name.replace(/[^\w.-]/g, '_')}`;
        const up = await db.storage.from('documents').upload(path, bytes, { contentType: f.type || 'application/octet-stream', upsert: true });
        if (up.error) { failed.push({ file: f.name, why: `could not store the file: ${up.error.message}` }); continue; }
        await db.from('documents').insert({
          workspace_id: me.workspace_id, candidate_id: cand.id, type: 'cv', storage_path: path,
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

async function transcribe(base64: string, mediaType: string) {
  const r = await claude.messages.create({
    model: MODEL_EXTRACT, max_tokens: 4000,
    messages: [{ role: 'user', content: [{ type: mediaType === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: mediaType as any, data: base64 } } as any, { type: 'text', text: 'Transcribe this CV as plain text, preserving structure. Output text only.' }] }],
  });
  return r.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');
}
