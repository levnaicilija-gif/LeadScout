import { NextResponse } from 'next/server';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { hasCandidateCrm } from '@/lib/schema-features';
import { checkPhone, checkEmail } from '@/lib/phone';
import { PREFERENCES } from '@/lib/candidate-stages';

/**
 * Edit a candidate's own fields from their page (item 24). SENSITIVE PERSONAL DATA: written with the signed-in user's
 * client, so row-level security decides; only the fields below can be changed here, each checked before it is saved.
 *
 *   PATCH { full_name?, phone?, email?, trade?, country?, availability_from?, notes?, employment_preference?, data_retention_until? }
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
