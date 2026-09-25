/**
 * Item 20 step 2c: the app reads a lead's and a company's state from the workspace's own tables, and
 * those tables are now the ONLY place that state exists.
 *
 *   npx tsx --env-file=.env.local scripts/lead-state-parity-check.ts
 *
 * THIS CHECK USED TO COMPARE THE TWO SIDES, and that is worth recording because the change is not a
 * simplification. While 2b dual-wrote, it counted open leads through `leads.status` and through the
 * state row and required the two to agree — and, because agreement alone would have been vacuous while
 * both were written from the same input, it then changed one state row and required them to DISAGREE.
 *
 * 0049 dropped the columns. There is no second reading left to compare against, so parity is not
 * merely unnecessary now, it is impossible — and the half that carried the weight was never the
 * agreement, it was the mutation. That half survives intact:
 *
 *   1. the state table is TOTAL — one row per lead, which is what every `!inner` read depends on;
 *   2. it REFUSES what the source columns refused — the three constraints 0047 dropped and 0048
 *      restored, asserted by attempting the bad write rather than by reading a type;
 *   3. THE COUNT FOLLOWS THE STATE ROW: close one lead and the open count falls by exactly one, then
 *      reopen it and the count returns. A read that were wired to anything else could not move.
 *   4. the same for a company, where a state row is CREATED rather than compared, because hiring
 *      status is set on zero companies and a check against an empty set passes whatever it claims.
 *
 * NOTHING IS SEEDED. It runs against the real rows, because what is being checked is whether the real
 * screens will show the real numbers. The one lead and one company it touches are put back exactly as
 * they were, and the run FAILS if they are not.
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

  const n = async (q: any, what: string) => { const { count, error } = await q; if (error) throw new Error(`${what}: ${error.code ?? '?'} ${error.message}`); return count ?? -1; };

  // ---- 1. total, which is what !inner depends on --------------------------------------------------
  // A lead without a state row does not read as "no status" — it VANISHES from every inner join, off
  // the table and out of every count, with nothing raised. 0048 backfilled and put a trigger on leads;
  // 0050 fixed that trigger after 0049 broke it by dropping the column it read.
  const [{ count: leadsTotal }, { count: stateTotal }] = await Promise.all([
    db.from('leads').select('id', { count: 'exact', head: true }).not('workspace_id', 'is', null),
    db.from(LEAD_STATE_TABLE).select('lead_id', { count: 'exact', head: true }),
  ]);
  if ((stateTotal ?? 0) < (leadsTotal ?? 0)) {
    console.error(`NOT JUDGED: ${leadsTotal} lead(s) but only ${stateTotal} state row(s) — 0048 is not applied, so an inner join would hide the rest`);
    process.exitCode = 2; return;
  }
  check('the lead state table is total', stateTotal === leadsTotal,
    `${leadsTotal} lead(s), ${stateTotal} state row(s) — every lead survives an inner join`);

  // ---- 2. the copies refuse what the originals refused -------------------------------------------
  // 0047 created these columns as `text` where the sources were typed, so they accepted values the
  // database was built to make impossible; 0048 converted them. Asserted by ATTEMPTING THE BAD WRITE,
  // never by reading a type out of the catalogue — a column that looks right and still accepts 'pursu'
  // would pass a catalogue check and fail the recruiter. Each write is expected to be REFUSED, so a
  // pass changes nothing; the unexpected case is repaired before moving on.
  const refuses = async (name: string, table: string, keyCols: Record<string, any>, patch: Record<string, any>, was: Record<string, any>) => {
    const { error } = await db.from(table).update(patch).match(keyCols);
    check(name, !!error, error ? `refused (${error.code}) — the copy enforces what the source enforced` : `ACCEPTED "${Object.values(patch)[0]}"`);
    if (!error) {
      await db.from(table).update(was).match(keyCols);
      const { data: back } = await db.from(table).select(Object.keys(was).join(',')).match(keyCols).maybeSingle();
      check('  ...and the bad value was put back', JSON.stringify(back) === JSON.stringify(was), JSON.stringify(back));
    }
  };
  const { data: anyLead } = await db.from(LEAD_STATE_TABLE).select('workspace_id, lead_id, status').limit(1).maybeSingle();
  if (anyLead) {
    await refuses("a typo'd lead status is refused", LEAD_STATE_TABLE,
      { workspace_id: anyLead.workspace_id, lead_id: anyLead.lead_id }, { status: 'pursu' }, { status: anyLead.status });
  }
  const { data: anyCo } = await db.from('workspace_company_state').select('workspace_id, company_id, employer_type_override, hiring_status').limit(1).maybeSingle();
  if (anyCo) {
    await refuses('a bad employer type is refused', 'workspace_company_state',
      { workspace_id: anyCo.workspace_id, company_id: anyCo.company_id }, { employer_type_override: 'agency_typo' }, { employer_type_override: anyCo.employer_type_override });
    await refuses('a bad hiring status is refused', 'workspace_company_state',
      { workspace_id: anyCo.workspace_id, company_id: anyCo.company_id }, { hiring_status: 'nonsense' }, { hiring_status: anyCo.hiring_status });
  }

  // ---- 3. the count follows the state row --------------------------------------------------------
  // The assertion that cannot pass vacuously, and the only one that ever could distinguish a switched
  // read from an unswitched one. It no longer needs a column to disagree with: if the open count falls
  // by exactly one when one state row closes, and returns when it reopens, the count is reading that
  // row and nothing else.
  const openWon = () => db.from('leads')
    .select(`id, ${LEAD_STATE_EMBED}`, { count: 'exact', head: true })
    .eq('kind', 'won_work').not(`${LEAD_STATE_TABLE}.status`, 'in', CLOSED_LEAD_STATUSES);

  const before = await n(openWon(), 'open won-work (before)');
  check('open won-work leads can be counted through the state row', before >= 0, `${before} open`);

  const { data: victim, error: vErr } = await db.from('leads')
    .select(`id, project_name, workspace_id, ${LEAD_STATE_EMBED}`)
    .eq('kind', 'won_work').eq(`${LEAD_STATE_TABLE}.status`, 'new').not('workspace_id', 'is', null)
    .order('id').limit(1).maybeSingle();
  if (vErr || !victim) {
    check('a lead could be found to mutate', false, vErr?.message ?? 'no open won-work lead exists to test with');
  } else {
    const state = Array.isArray((victim as any).workspace_lead_state) ? (victim as any).workspace_lead_state[0] : (victim as any).workspace_lead_state;
    const was = state?.status ?? 'new';
    try {
      const { error: upErr } = await db.from(LEAD_STATE_TABLE).update({ status: 'not_for_us' })
        .eq('workspace_id', victim.workspace_id).eq('lead_id', victim.id);
      if (upErr) throw new Error(`the state row could not be changed: ${upErr.message}`);

      const after = await n(openWon(), 'open won-work (after)');
      check('THE COUNT FOLLOWS THE STATE ROW', after === before - 1,
        `${before} open, then one state row set to not_for_us, then ${after} — the count moved with the row, by exactly one`);
    } finally {
      const { error: reErr } = await db.from(LEAD_STATE_TABLE).update({ status: was })
        .eq('workspace_id', victim.workspace_id).eq('lead_id', victim.id);
      const restored = await n(openWon(), 'open won-work (restored)');
      check('and reopening it restores the count', !reErr && restored === before,
        reErr ? reErr.message : `back to ${restored} — the fall was caused by the status, not by anything else in the query`);
      const { data: back } = await db.from(LEAD_STATE_TABLE).select('status')
        .eq('workspace_id', victim.workspace_id).eq('lead_id', victim.id).maybeSingle();
      check('the lead was put back exactly as it was', back?.status === was,
        `${victim.project_name ?? victim.id} reads "${back?.status}" again`);
    }
  }

  // ---- 4. the company side, where the row is CREATED rather than compared ------------------------
  // Hiring status is set on ZERO companies, so there is nothing on file to test against and a check
  // that merely counted would pass on an empty set whatever it claimed. A row is made, the count is
  // required to MOVE, and the row is removed.
  const pursued = (ws: string) => db.from('companies')
    .select('name, workspace_company_state!inner(hiring_status)', { count: 'exact', head: true })
    .eq('workspace_company_state.workspace_id', ws)
    .eq('workspace_company_state.hiring_status', 'pursued');

  const { data: co } = await db.from('companies').select('id, name, workspace_id')
    .not('workspace_id', 'is', null).order('id').limit(1).maybeSingle();
  if (!co) check('a company could be found to mutate', false, 'no company with a workspace exists to test with');
  else {
    const { data: had } = await db.from('workspace_company_state').select('company_id')
      .eq('workspace_id', co.workspace_id).eq('company_id', co.id).maybeSingle();
    if (had) {
      check('a company without a state row could be found', false, `${co.name} already has one — the probe would have to alter real state to test`);
    } else {
      const wsBefore = await n(pursued(co.workspace_id), 'pursued (before)');
      let created = false;
      try {
        const { error: insErr } = await db.from('workspace_company_state')
          .insert({ workspace_id: co.workspace_id, company_id: co.id, hiring_status: 'pursued' });
        if (insErr) throw new Error(`the company state row could not be written: ${insErr.message}`);
        created = true;
        const wsAfter = await n(pursued(co.workspace_id), 'pursued (after)');
        check('THE COMPANY COUNT FOLLOWS THE STATE ROW', wsAfter === wsBefore + 1,
          `${wsBefore} pursued, then a state row for ${co.name}, then ${wsAfter} — Radar's target list reads this`);
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
  }

  console.log(`\n${ok.length} passed, ${fail.length} failed`);
  if (fail.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
