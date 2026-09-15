import { NextResponse } from 'next/server';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { hasCandidateCrm } from '@/lib/schema-features';

/**
 * Log that a candidate's CV went to a client (item 24). The log is the existing `sends` table — the pack-send flow already
 * writes there — extended by 0035 with the client's name (for a client that is not a company on file) and a note.
 * SENSITIVE PERSONAL DATA: written with the signed-in user's client; sends is scoped to the workspace through the candidate.
 *
 *   POST { client, sent_on?, note? }     appends; nothing in the log is edited or removed here
 *
 * sent_by is the signed-in user and sent_at the date given (today by default), the same who-and-when pattern as a lead's
 * confirmed_by / confirmed_at. When the client's name matches a company on file exactly, the row links it too.
 */
const isDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const sb = supabaseServer();
  if (!(await hasCandidateCrm(sb))) return NextResponse.json({ error: 'Logging a CV sent to a client arrives with migration 0035, which is not applied yet.' }, { status: 409 });

  const b = await req.json().catch(() => ({}));
  const client = String(b.client ?? '').trim();
  if (!client) return NextResponse.json({ error: 'which client was the CV sent to?' }, { status: 400 });
  if (client.length > 200) return NextResponse.json({ error: 'the client name is at most 200 characters' }, { status: 400 });
  if (b.sent_on && !isDate(b.sent_on)) return NextResponse.json({ error: 'the date sent is yyyy-mm-dd' }, { status: 400 });

  const { data: cand } = await sb.from('candidates').select('id, workspace_id').eq('id', params.id).maybeSingle();
  if (!cand) return NextResponse.json({ error: 'no such candidate in your workspace' }, { status: 404 });
  const { data: company } = await sb.from('companies').select('id').eq('workspace_id', cand.workspace_id).ilike('name', client).limit(1).maybeSingle();

  const sentAt = b.sent_on && b.sent_on !== new Date().toISOString().slice(0, 10) ? `${b.sent_on}T12:00:00Z` : new Date().toISOString();
  const { data: row, error } = await sb.from('sends').insert({
    candidate_id: cand.id, company_id: company?.id ?? null, client_name: client, note: b.note ? String(b.note).slice(0, 1000) : null,
    sent_by: me.id, sent_at: sentAt,
  }).select('id, client_name, sent_at, sent_by, note').single();
  if (error) return NextResponse.json({ error: `the CV sent could not be logged: ${error.message}` }, { status: 500 });
  return NextResponse.json({ ok: true, send: row, linkedCompany: !!company });
}
