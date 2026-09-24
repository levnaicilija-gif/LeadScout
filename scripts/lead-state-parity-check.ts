/**
 * Item 20 step 2b: the app now reads lead and company state from workspace_lead_state and
 * workspace_company_state. Does it show the same thing — and is it REALLY reading the new table?
 *
 *   npx tsx --env-file=.env.local scripts/lead-state-parity-check.ts
 *
 * TWO QUESTIONS, and the second is the one that matters.
 *
 * PARITY alone is worthless here, because 2b DUAL-WRITES: `leads.status` and the state row hold the
 * same value, so a query that had never been switched at all would agree with one that had. Every
 * count below would match and prove nothing. This is the vacuous-assertion trap this codebase has
 * now hit three times — the Dutch BUTTON overlap, the "no unblocked job called Welder" list, the
 * bullet the stub rotated — and it would hit it again here in its most expensive form.
 *
 * So parity is checked FIRST, and then DISPROVED as sufficient: one lead's STATE ROW is changed
 * while its COLUMN is deliberately left alone, and the two counts must then DISAGREE, in the right
 * direction, by exactly one. A query still reading the column cannot move. That is the only evidence
 * that separates "switched" from "not switched", and it is why the mutation is not optional.
 *
 * The same is done for a company's hiring status.
 *
 * NOTHING HERE IS SEEDED. It runs against the real rows, because the thing being checked is whether
 * the real screens will show the real numbers. The one lead and one company it touches are put back
 * exactly as they were, and the run FAILS if they are not.
 */
import { createClient } from '@supabase/supabase-js';
import { CLOSED_LEAD_STATUSES, LEAD_STATE_EMBED, LEAD_STATE_TABLE } from '../src/lib/workspace-state';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const fail: string[] = [];
const ok: string[] = [];
function check(name: string, pass: boolean, detail: string) {
  (pass ? ok : fail).push(`${name} — ${detail}`);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
}

async function main() {
  if (!url || !key) { console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'); process.exitCode = 1; return; }
  const db = createClient(url, key, { auth: { persistSession: false } });

  // 0048 must be in, or `!inner` hides every untouched lead and the numbers below are meaningless.
  // Said as "not judged" (exit 2) rather than a failure: nothing is broken, the step is not ready.
  const [{ count: leadsTotal }, { count: stateTotal }] = await Promise.all([
    db.from('leads').select('id', { count: 'exact', head: true }).not('workspace_id', 'is', null),
    db.from(LEAD_STATE_TABLE).select('lead_id', { count: 'exact', head: true }),
  ]);
  if ((stateTotal ?? 0) < (leadsTotal ?? 0)) {
    console.error(`NOT JUDGED: ${leadsTotal} lead(s) but only ${stateTotal} state row(s) — 0048 is not applied, so an inner join would hide the rest`);
    process.exitCode = 2; return;
  }
  check('the lead state table is total', stateTotal === leadsTotal, `${leadsTotal} lead(s), ${stateTotal} state row(s) — every lead can survive an inner join`);

  // ---- 0048 part 1: the copies refuse what the originals refuse ----------------------------------
  // 0047 made these columns `text` where the source columns are typed, so the state tables accepted
  // values the database was built to make impossible — and because 2b dual-writes state-first with
  // the column's error unread, a typo'd status would stick in the state row while leads.status kept
  // the old value, quietly dropping the lead out of every `status = 'new'` count.
  //
  // Asserted by ATTEMPTING THE BAD WRITE, not by reading the column type: a type that looks right in
  // the catalogue and still accepts 'pursu' would pass a catalogue check and fail the recruiter.
  // Each write below is expected to be REFUSED, so a pass changes nothing; the unexpected case —
  // it succeeds — is repaired before moving on.
  const refuses = async (name: string, table: string, key: Record<string, any>, patch: Record<string, any>, was: Record<string, any>) => {
    const { error } = await db.from(table).update(patch).match(key);
    check(name, !!error, error ? `refused (${error.code}) — the copy enforces what the source enforces` : `ACCEPTED "${Object.values(patch)[0]}", which the source column refuses`);
    if (!error) {
      await db.from(table).update(was).match(key);
      const { data: back } = await db.from(table).select(Object.keys(was).join(',')).match(key).maybeSingle();
      check(`  ...and the bad value was put back`, JSON.stringify(back) === JSON.stringify(was), JSON.stringify(back));
    }
  };
  const { data: anyLead } = await db.from(LEAD_STATE_TABLE).select('workspace_id, lead_id, status').limit(1).maybeSingle();
  if (anyLead) {
    await refuses('a typo\'d lead status is refused', LEAD_STATE_TABLE,
      { workspace_id: anyLead.workspace_id, lead_id: anyLead.lead_id }, { status: 'pursu' }, { status: anyLead.status });
  }
  const { data: anyCo } = await db.from('workspace_company_state').select('workspace_id, company_id, employer_type_override, hiring_status').limit(1).maybeSingle();
  if (anyCo) {
    await refuses('a bad employer type is refused', 'workspace_company_state',
      { workspace_id: anyCo.workspace_id, company_id: anyCo.company_id }, { employer_type_override: 'agency_typo' }, { employer_type_override: anyCo.employer_type_override });
    await refuses('a bad hiring status is refused', 'workspace_company_state',
      { workspace_id: anyCo.workspace_id, company_id: anyCo.company_id }, { hiring_status: 'nonsense' }, { hiring_status: anyCo.hiring_status });
  }

  // ---- the four read shapes the app actually uses -------------------------------------------------
  const oldOpenWon = () => db.from('leads').select('id', { count: 'exact', head: true }).eq('kind', 'won_work').not('status', 'in', CLOSED_LEAD_STATUSES);
  const newOpenWon = () => db.from('leads').select(`id, ${LEAD_STATE_EMBED}`, { count: 'exact', head: true }).eq('kind', 'won_work').not(`${LEAD_STATE_TABLE}.status`, 'in', CLOSED_LEAD_STATUSES);
  const oldNew = () => db.from('leads').select('id', { count: 'exact', head: true }).eq('status', 'new');
  const newNew = () => db.from('leads').select(`id, ${LEAD_STATE_EMBED}`, { count: 'exact', head: true }).eq(`${LEAD_STATE_TABLE}.status`, 'new');
  const oldOpenAny = () => db.from('leads').select('id', { count: 'exact', head: true }).not('status', 'in', CLOSED_LEAD_STATUSES);
  const newOpenAny = () => db.from('leads').select(`id, ${LEAD_STATE_EMBED}`, { count: 'exact', head: true }).not(`${LEAD_STATE_TABLE}.status`, 'in', CLOSED_LEAD_STATUSES);

  const n = async (q: any, what: string) => { const { count, error } = await q; if (error) throw new Error(`${what}: ${error.code ?? '?'} ${error.message}`); return count ?? -1; };

  const pairs: { name: string; oldQ: () => any; newQ: () => any }[] = [
    { name: 'open won-work leads (Today, Leads)', oldQ: oldOpenWon, newQ: newOpenWon },
    { name: 'untouched leads (Home, the rail badge)', oldQ: oldNew, newQ: newNew },
    { name: 'open leads of any kind (Pitch, /api/leads/open)', oldQ: oldOpenAny, newQ: newOpenAny },
  ];
  const before: Record<string, number> = {};
  for (const p of pairs) {
    const a = await n(p.oldQ(), `${p.name} (column)`);
    const b = await n(p.newQ(), `${p.name} (state)`);
    before[p.name] = b;
    check(`parity: ${p.name}`, a === b, `${a} through leads.status, ${b} through the state row`);
  }

  // Confirmations, which the scorecard now counts on the state table directly.
  const confirmedCol = await n(db.from('leads').select('id', { count: 'exact', head: true }).not('confirmed_by', 'is', null), 'confirmations (column)');
  const confirmedState = await n(db.from(LEAD_STATE_TABLE).select('lead_id', { count: 'exact', head: true }).not('confirmed_by', 'is', null), 'confirmations (state)');
  check('parity: confirmations (the scorecard)', confirmedCol === confirmedState, `${confirmedCol} on leads, ${confirmedState} on state rows`);

  // ---- and now the part that makes any of the above mean something --------------------------------
  // Pick a lead that is OPEN by both readings, change ONLY its state row, and require the two to
  // disagree. Restored in a finally, and the restore is read back.
  const { data: victim, error: vErr } = await db.from('leads')
    .select('id, project_name, status, workspace_id')
    .eq('kind', 'won_work').eq('status', 'new').not('workspace_id', 'is', null)
    .order('id').limit(1).maybeSingle();
  if (vErr || !victim) { check('a lead could be found to mutate', false, vErr?.message ?? 'no open won-work lead exists to test with'); }
  else {
    const was = victim.status;
    try {
      const { error: upErr } = await db.from(LEAD_STATE_TABLE).update({ status: 'not_for_us' })
        .eq('workspace_id', victim.workspace_id).eq('lead_id', victim.id);
      if (upErr) throw new Error(`the state row could not be changed: ${upErr.message}`);

      const colAfter = await n(oldOpenWon(), 'open won-work (column, after)');
      const stateAfter = await n(newOpenWon(), 'open won-work (state, after)');
      const { data: stillCol } = await db.from('leads').select('status').eq('id', victim.id).single();

      check('the lead column was deliberately NOT changed', stillCol?.status === was,
        `leads.status is still "${stillCol?.status}" — only the state row moved, which is what makes the next two checks mean anything`);
      check('THE READ COMES FROM THE STATE TABLE', stateAfter === before['open won-work leads (Today, Leads)'] - 1,
        `${before['open won-work leads (Today, Leads)']} open, then one state row set to not_for_us, then ${stateAfter} — a query still reading leads.status could not have moved`);
      check('and the old column is now demonstrably stale', colAfter === before['open won-work leads (Today, Leads)'],
        `leads.status still counts ${colAfter} — the two readings now DISAGREE, so parity above was not vacuous`);
    } finally {
      const { error: reErr } = await db.from(LEAD_STATE_TABLE).update({ status: was })
        .eq('workspace_id', victim.workspace_id).eq('lead_id', victim.id);
      const { data: back } = await db.from(LEAD_STATE_TABLE).select('status')
        .eq('workspace_id', victim.workspace_id).eq('lead_id', victim.id).maybeSingle();
      check('the lead was put back exactly as it was', !reErr && back?.status === was,
        reErr ? reErr.message : `${victim.project_name ?? victim.id} reads "${back?.status}" again`);
    }
  }

  // ---- the same for a company's hiring status ----------------------------------------------------
  // Hiring status is set on ZERO companies today, so there is nothing to compare — which is exactly
  // the case where a check quietly passes on an empty set. A row is therefore CREATED, tested, and
  // removed, and the assertion is that the count MOVED, not that it matched.
  const { data: co } = await db.from('companies').select('id, name, workspace_id, hiring_status')
    .not('workspace_id', 'is', null).is('hiring_status', null).order('id').limit(1).maybeSingle();
  if (!co) check('a company could be found to mutate', false, 'no company without a hiring status exists to test with');
  else {
    const pursuedBefore = await n(db.from('companies').select('name, workspace_company_state!inner(hiring_status)', { count: 'exact', head: true })
      .eq('workspace_company_state.workspace_id', co.workspace_id).eq('workspace_company_state.hiring_status', 'pursued'), 'pursued (state, before)');
    let created = false;
    try {
      const { error: insErr } = await db.from('workspace_company_state')
        .upsert({ workspace_id: co.workspace_id, company_id: co.id, hiring_status: 'pursued' }, { onConflict: 'workspace_id,company_id' });
      if (insErr) throw new Error(`the company state row could not be written: ${insErr.message}`);
      created = true;
      const pursuedAfter = await n(db.from('companies').select('name, workspace_company_state!inner(hiring_status)', { count: 'exact', head: true })
        .eq('workspace_company_state.workspace_id', co.workspace_id).eq('workspace_company_state.hiring_status', 'pursued'), 'pursued (state, after)');
      const { data: stillCo } = await db.from('companies').select('hiring_status').eq('id', co.id).single();
      check('THE COMPANY READ COMES FROM THE STATE TABLE', pursuedAfter === pursuedBefore + 1,
        `${pursuedBefore} pursued, then a state row for ${co.name}, then ${pursuedAfter} — Radar's target list reads this`);
      check('the company column was deliberately NOT changed', stillCo?.hiring_status === null,
        'companies.hiring_status is still null, so the move above came from the state row alone');
    } finally {
      if (created) {
        const { error: delErr } = await db.from('workspace_company_state').delete()
          .eq('workspace_id', co.workspace_id).eq('company_id', co.id);
        const { data: gone } = await db.from('workspace_company_state').select('company_id')
          .eq('workspace_id', co.workspace_id).eq('company_id', co.id).maybeSingle();
        check('the company was put back exactly as it was', !delErr && !gone,
          delErr ? delErr.message : `the state row created for ${co.name} is gone`);
      }
    }
  }

  console.log(`\n${ok.length} passed, ${fail.length} failed`);
  if (fail.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
