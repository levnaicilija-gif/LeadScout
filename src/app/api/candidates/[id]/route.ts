import { NextResponse } from 'next/server';
import { supabaseServer, supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { hasCandidateCrm, hasTable } from '@/lib/schema-features';
import { candidateLabel } from '@/lib/candidate-number';
import { normName } from '@/lib/name-match';
import { candidateIds, candidateRowCounts, candidateFiles, removeFiles, deleteFunctionReady } from '@/lib/candidate-deletion';
import { checkPhone, checkEmail } from '@/lib/phone';
import { PREFERENCES } from '@/lib/candidate-stages';

/**
 * Edit a candidate's own fields from their page (item 24). SENSITIVE PERSONAL DATA: written with the signed-in user's
 * client, so row-level security decides; only the fields below can be changed here, each checked before it is saved.
 *
 *   PATCH { full_name?, phone?, email?, trade?, country?, availability_from?, notes?, employment_preference?, data_retention_until? }
 *   DELETE { confirm }   the candidate and everything tied to them, permanently — see DELETE below
 *
 * The phone is checked for shape only (src/lib/phone.ts) — never looked up anywhere. A field that is wrong is refused with
 * what is wrong; nothing is half-saved.
 */
const isDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const sb = supabaseServer();
  const crm = await hasCandidateCrm(sb);
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== 'object') return NextResponse.json({ error: 'send the fields to change as JSON' }, { status: 400 });

  const patch: Record<string, unknown> = {};
  const problems: Record<string, string> = {};
  const text = (key: string, column: string, max: number) => {
    if (!(key in b)) return;
    const v = b[key] === null ? '' : String(b[key]).trim();
    if (v.length > max) problems[key] = `at most ${max} characters`;
    else patch[column] = v || null;
  };
  text('full_name', 'full_name', 200);
  text('trade', 'trade', 120);
  text('notes', 'internal_notes', 5000);
  if ('phone' in b) { const c = checkPhone(b.phone); if (c.ok) patch.phone = c.value; else problems.phone = c.error; }
  if ('email' in b) { const c = checkEmail(b.email); if (c.ok) patch.email = c.value; else problems.email = c.error; }
  if ('availability_from' in b) {
    if (b.availability_from === null || b.availability_from === '') patch.availability_from = null;
    else if (isDate(b.availability_from)) patch.availability_from = b.availability_from;
    else problems.availability_from = 'a date, yyyy-mm-dd';
  }
  const crmOnly = ['country', 'employment_preference', 'data_retention_until'].filter((k) => k in b);
  if (crmOnly.length && !crm) return NextResponse.json({ error: `${crmOnly.join(', ')} arrive with migration 0035, which is not applied yet.` }, { status: 409 });
  if (crm) {
    text('country', 'country', 80);
    if ('employment_preference' in b) {
      if (b.employment_preference === null || b.employment_preference === '') patch.employment_preference = null;
      else if ((PREFERENCES as readonly string[]).includes(b.employment_preference)) patch.employment_preference = b.employment_preference;
      else problems.employment_preference = 'Permanent, Contract or Either';
    }
    if ('data_retention_until' in b) {
      if (b.data_retention_until === null || b.data_retention_until === '') patch.data_retention_until = null;
      else if (isDate(b.data_retention_until)) patch.data_retention_until = b.data_retention_until;
      else problems.data_retention_until = 'a date, yyyy-mm-dd';
    }
  }
  if (Object.keys(problems).length) return NextResponse.json({ error: 'Some fields were not saved.', problems }, { status: 400 });
  if (!Object.keys(patch).length) return NextResponse.json({ error: 'nothing to change' }, { status: 400 });

  const { data, error } = await sb.from('candidates').update(patch).eq('id', params.id).select('id').maybeSingle();
  if (error) return NextResponse.json({ error: `the candidate could not be saved: ${error.message}` }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'no such candidate in your workspace' }, { status: 404 });
  return NextResponse.json({ ok: true, saved: Object.keys(patch) });
}

/**
 * Delete a candidate and everything tied to them, permanently (item 24 follow-up 3, step 7). SENSITIVE PERSONAL DATA.
 *
 * A senior's action (owner's decision, 2026-09-15), confirmed by typing the candidate's name — any case or order — or their
 * number ("#9") when no name is on file. In this order, so the deletion is on record even if it stops part-way:
 *   0. migration 0037 must be there in full — the log table, and the function that deletes the rows; checked before
 *      anything is touched, so files are never erased for a candidate whose rows cannot then be deleted;
 *   1. deletion_log gets a row: their number and reference code, who, when, and the rows counted per table — never the name;
 *   2. their stored files are erased: every document's file and issuer screenshot, every client version's PDF;
 *   3. delete_candidate_rows removes their rows in one transaction (0037): CV-sent log and scores first — they reference the
 *      candidate with no cascade — then the candidate, whose documents, verifications, client versions, campaign links,
 *      internal downloads and placements cascade;
 *   4. every table is counted again for them, and the log row is completed with what went, or names what was left.
 * A document already taken off them (detached) is not theirs any more and is not touched.
 */
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  if (me.role !== 'senior') return NextResponse.json({ error: 'Only a senior can delete a candidate.' }, { status: 403 });
  const { data: cand, error } = await supabaseServer().from('candidates').select('id, workspace_id, reference_code, full_name').eq('id', params.id).maybeSingle();
  if (error) return NextResponse.json({ error: `the candidate could not be read: ${error.message}` }, { status: 500 });
  if (!cand || cand.workspace_id !== me.workspace_id) return NextResponse.json({ error: 'no such candidate in your workspace' }, { status: 404 });

  const label = candidateLabel(cand.reference_code);
  const b = await req.json().catch(() => ({}));
  const typed = String(b?.confirm ?? '').trim();
  const named = !!cand.full_name?.trim();
  const confirmed = named ? normName(typed) !== '' && normName(typed) === normName(cand.full_name) : typed === label;
  if (!confirmed) return NextResponse.json({ error: named ? "Type the candidate's name to confirm — nothing was deleted." : `Type ${label} to confirm — nothing was deleted.` }, { status: 400 });

  const db = supabaseAdmin();
  if (!(await hasTable(db, 'deletion_log')) || !(await deleteFunctionReady(db))) {
    return NextResponse.json({ error: 'Deleting a candidate needs migration 0037 in full (the deletion log and its delete function), and it is not all in the database yet. Nothing was deleted.' }, { status: 409 });
  }

  let ids, before;
  try { ids = await candidateIds(db, cand.id); before = await candidateRowCounts(db, cand.id, ids); }
  catch (e: any) { return NextResponse.json({ error: `Nothing was deleted: ${e?.message ?? e}` }, { status: 500 }); }

  const { data: log, error: logError } = await db.from('deletion_log').insert({
    workspace_id: me.workspace_id, kind: 'candidate', subject_id: cand.id, subject_ref: `${label} · ${cand.reference_code}`, deleted_by: me.id, removed: { before },
  }).select('id').single();
  if (logError || !log) return NextResponse.json({ error: `The deletion could not be recorded, so nothing was deleted: ${logError?.message ?? 'no log row'}` }, { status: 500 });
  const finish = (patch: Record<string, unknown>) => db.from('deletion_log').update(patch).eq('id', log.id);

  const files = await removeFiles(db, candidateFiles(me.workspace_id, ids));
  if (files.error) {
    await finish({ error: files.error, removed: { before, files: files.removed } });
    return NextResponse.json({ error: `Their files could not all be erased, so their record was kept: ${files.error}` }, { status: 500 });
  }
  const { data: rows, error: rpcError } = await db.rpc('delete_candidate_rows', { p_candidate: cand.id, p_workspace: me.workspace_id });
  if (rpcError) {
    await finish({ error: rpcError.message, removed: { before, files: files.removed } });
    return NextResponse.json({ error: `Their files were erased but their rows could not be deleted: ${rpcError.message}` }, { status: 500 });
  }

  let after;
  try { after = await candidateRowCounts(db, cand.id, ids); }
  catch (e: any) { await finish({ error: `deleted, but could not be counted again: ${e?.message ?? e}`, removed: { before, rows, files: files.removed } }); return NextResponse.json({ error: `Deleted, but the check afterwards could not run: ${e?.message ?? e}` }, { status: 500 }); }
  const left = Object.entries(after).filter(([, n]) => n > 0);
  await finish({
    completed_at: left.length ? null : new Date().toISOString(),
    removed: { before, rows, after, files: files.removed },
    error: left.length ? `left behind: ${left.map(([t, n]) => `${t} ${n}`).join(', ')}` : null,
  });
  if (left.length) return NextResponse.json({ error: `Rows were left behind: ${left.map(([t, n]) => `${t} ${n}`).join(', ')}`, before, after }, { status: 500 });
  return NextResponse.json({ ok: true, deleted: label, before, after, files: files.removed });
}
