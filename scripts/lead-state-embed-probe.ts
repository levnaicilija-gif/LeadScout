/**
 * Item 20 step 2b: does reading a lead's status THROUGH THE EMBED behave like reading the column?
 *
 *   npx tsx --env-file=.env.local scripts/lead-state-embed-probe.ts
 *
 * WHY THIS RUNS BEFORE THE APP IS SWITCHED, not after. `openLeads` in radar/page.tsx is described in
 * CLAUDE.md as "the one closure the table, both source counts and the chip numbers all pass through",
 * and it filters status IN SQL. Moving that filter onto an embedded table is not a refactor — it
 * changes the query PostgREST builds. If an embedded filter is ignored on a `head: true` count, every
 * chip on Radar silently counts a different set from the table beneath it, which is precisely the
 * failure CLAUDE.md warns about by name: "the banner counting one set and the table showing another".
 * No error is raised in that case. It would look completely fine.
 *
 * So the mechanism is proven on real PostgREST, against real rows, before ~18 read sites are rewritten
 * to depend on it.
 *
 * WHAT IS ASSERTED, all positively — a count that MOVES when the data moves, never "no error":
 *   1. the embed returns the state row's status, not the lead's column;
 *   2. `!inner` DROPS a lead with no state row — which is the whole reason 0048 makes the table total;
 *   3. a filter on the embedded column changes a `head: true` EXACT COUNT, by exactly the right number;
 *   4. the same filter changes the ROW LIST by the same number — count and table agree;
 *   5. the count follows a MUTATION: flip one state row to 'not_for_us' and the count falls by one,
 *      flip it back and it returns. A filter that were ignored would give the same number three times.
 *
 * Everything is made in a throwaway workspace and deleted afterwards; a leftover fails the run.
 */
import { createClient } from '@supabase/supabase-js';
import { markTest, markWorkspaceTest, removeProbe } from '../src/lib/test-data';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CLOSED = '("stale","not_for_us")';

const fail: string[] = [];
const ok: string[] = [];
function check(name: string, pass: boolean, detail: string) {
  (pass ? ok : fail).push(`${name} — ${detail}`);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
}

async function main() {
  if (!url || !key) { console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'); process.exitCode = 1; return; }
  const db = createClient(url, key, { auth: { persistSession: false } });

  // The table must exist before anything below means anything. Said plainly rather than crashing
  // with a PostgREST code, because "not applied yet" is a different answer from "broken".
  const { error: tableErr } = await db.from('workspace_lead_state').select('lead_id').limit(1);
  if (tableErr) { console.error(`workspace_lead_state is not readable (${tableErr.code ?? '?'} ${tableErr.message}) — apply 0047/0048 first`); process.exitCode = 2; return; }

  const slug = `embed-probe-${Date.now().toString(36)}`;
  const { data: ws, error: wsErr } = await db.from('workspaces').insert({ name: 'Embed Probe Workspace', slug }).select('id').single();
  if (wsErr || !ws) { console.error(`could not create the probe workspace: ${wsErr?.message}`); process.exitCode = 1; return; }
  await markWorkspaceTest(db, ws.id);

  try {
    const { data: co } = await db.from('companies').insert({ workspace_id: ws.id, name: 'Embed Probe Co' }).select('id').single();
    // Marked, or cleanup REFUSES to delete them and strands the workspace — the one-directional rule
    // in test-data.ts is "a row without the flag is real, always". The first run of this probe left
    // one behind for exactly this reason.
    if (co) await markTest(db, 'companies', [co.id]);

    // Four leads of one kind, so every query below can pin `kind` the way openLeads does and never
    // see another test's rows. Three get a state row; the FOURTH deliberately gets none.
    // No status: 0049 dropped leads.status, and 0048's trigger gives every new lead a state row whose
    // status defaults to 'new'. That default is what the probe relies on below.
    const mk = (n: string) => ({ workspace_id: ws.id, company_id: co?.id ?? null, kind: 'won_work', project_name: n });
    const { data: leads, error: leadErr } = await db.from('leads').insert([mk('Embed A'), mk('Embed B'), mk('Embed C'), mk('Embed D')]).select('id, project_name');
    if (leadErr || !leads) throw new Error(`could not create probe leads: ${leadErr?.message}`);
    const byName = new Map(leads.map((l: any) => [l.project_name as string, l.id as string]));
    await markTest(db, 'leads', leads.map((l: any) => l.id));

    // 0048's trigger may already have made all four. Delete D's row so the !inner assertion is real.
    await db.from('workspace_lead_state').upsert(
      ['Embed A', 'Embed B', 'Embed C'].map((n) => ({ workspace_id: ws.id, lead_id: byName.get(n)!, status: 'new' })),
      { onConflict: 'workspace_id,lead_id' },
    );
    await db.from('workspace_lead_state').delete().eq('workspace_id', ws.id).eq('lead_id', byName.get('Embed D')!);

    const inWs = (q: any) => q.eq('workspace_id', ws.id).eq('kind', 'won_work');
    const countJoined = async (closed: boolean) => {
      let q = inWs(db.from('leads').select('id, workspace_lead_state!inner(status)', { count: 'exact', head: true }));
      if (closed) q = q.not('workspace_lead_state.status', 'in', CLOSED);
      const { count, error } = await q;
      if (error) throw new Error(`embedded count failed: ${error.code ?? '?'} ${error.message}`);
      return count ?? -1;
    };
    const rowsJoined = async (closed: boolean) => {
      let q = inWs(db.from('leads').select('id, project_name, workspace_lead_state!inner(status)'));
      if (closed) q = q.not('workspace_lead_state.status', 'in', CLOSED);
      const { data, error } = await q;
      if (error) throw new Error(`embedded select failed: ${error.code ?? '?'} ${error.message}`);
      return (data ?? []) as any[];
    };

    // ---- 1. the embed carries the state row's status, not the lead's column ----------------------
    // This used to set the state row and the COLUMN apart, and assert the embed reported the state
    // row's value rather than the column's. 0049 dropped leads.status, so there is no longer a column
    // to be echoing — that comparison is not merely impossible now, it is meaningless.
    //
    // What still has to hold, and still discriminates: the embed reports the value actually WRITTEN
    // rather than the 'new' every row is created with. A read that returned the default, or nothing,
    // fails here.
    await db.from('workspace_lead_state').update({ status: 'pursue' }).eq('workspace_id', ws.id).eq('lead_id', byName.get('Embed A')!);
    const aRow = (await rowsJoined(false)).find((r) => r.project_name === 'Embed A');
    const aState = Array.isArray(aRow?.workspace_lead_state) ? aRow.workspace_lead_state[0] : aRow?.workspace_lead_state;
    check('the embed reports what was written, not the default', aState?.status === 'pursue',
      `the row was created with 'new' and set to 'pursue', and the embed says "${aState?.status}"`);

    // ---- 2. !inner drops a lead with no state row ------------------------------------------------
    const joinedAll = await rowsJoined(false);
    const plain = await inWs(db.from('leads').select('id'));
    check('!inner drops a stateless lead', joinedAll.length === 3 && (plain.data ?? []).length === 4,
      `4 leads exist, the join returns 3 — Embed D has no state row and disappears, which is exactly why 0048 makes the table total`);

    // ---- 3 & 4. the filter moves the count AND the rows, together --------------------------------
    await db.from('workspace_lead_state').update({ status: 'new' }).eq('workspace_id', ws.id).eq('lead_id', byName.get('Embed A')!);
    const openBefore = await countJoined(true);
    const rowsBefore = await rowsJoined(true);
    check('count and rows agree before the mutation', openBefore === 3 && rowsBefore.length === 3,
      `head count ${openBefore}, row list ${rowsBefore.length}`);

    // ---- 5. THE MUTATION: close one, and watch the count fall by exactly one ----------------------
    // This is the assertion that cannot pass vacuously. If PostgREST ignored the embedded filter on a
    // head count, every number here would be 3 and the check would fail.
    await db.from('workspace_lead_state').update({ status: 'not_for_us' }).eq('workspace_id', ws.id).eq('lead_id', byName.get('Embed B')!);
    const openAfter = await countJoined(true);
    const rowsAfter = await rowsJoined(true);
    check('an exact head count follows the embedded filter', openAfter === openBefore - 1,
      `${openBefore} open, then Embed B is marked not_for_us, then ${openAfter} — the count moved with the data`);
    check('the row list moves with the count', rowsAfter.length === openAfter && !rowsAfter.some((r) => r.project_name === 'Embed B'),
      `${rowsAfter.length} row(s), Embed B absent — the banner and the table narrow together`);

    // ---- and back, so the change is shown to be the cause ----------------------------------------
    await db.from('workspace_lead_state').update({ status: 'new' }).eq('workspace_id', ws.id).eq('lead_id', byName.get('Embed B')!);
    const openRestored = await countJoined(true);
    check('reopening restores the count', openRestored === openBefore,
      `back to ${openRestored} — the fall was caused by the status, not by anything else in the query`);

    // ---- the `or()` that openLeads chains must survive the embed ---------------------------------
    // Radar chains `.or('source_url.is.null,source_url.not.ilike...')` onto the same builder. An `or`
    // on the PARENT alongside a filter on an EMBEDDED table is the one combination most likely to be
    // mis-parsed, and it is on the live path for both news and tender counts.
    const { count: orCount, error: orErr } = await inWs(db.from('leads').select('id, workspace_lead_state!inner(status)', { count: 'exact', head: true }))
      .not('workspace_lead_state.status', 'in', CLOSED)
      .or('source_url.is.null,source_url.not.ilike.https://ted.europa.eu/*');
    check('or() on the parent survives an embedded filter', !orErr && orCount === openBefore,
      orErr ? `${orErr.code ?? '?'} ${orErr.message}` : `${orCount} — all 3 open leads have a null source_url and are counted`);
  } finally {
    // In FK order and BY HAND: companies.workspace_id has no cascade, so deleting the workspace alone
    // fails on it — the first run of this probe stranded a workspace for exactly that reason, and
    // marking the rows is_test was not enough because deleteTestWorkspace never deletes companies.
    // Each delete's error is READ; a silent failure here is what left the mess in the first place.
    const leftovers: string[] = [];
    for (const t of ['workspace_lead_state', 'leads', 'companies'] as const) {
      const { error } = await db.from(t).delete().eq('workspace_id', ws.id);
      if (error) leftovers.push(`${t}: ${error.message}`);
    }
    // A leftover is a FAILURE, not a note. The first run printed a cleanup line and still exited 0,
    // which is the same "reported success while leaving a mess" shape the probes exist to catch.
    const left = [...leftovers, await removeProbe(db, null, ws.id)].filter(Boolean).join('; ') || null;
    if (left) check('the probe cleans up after itself', false, left);
    else check('the probe cleans up after itself', true, 'the throwaway workspace and everything in it are gone');
  }

  console.log(`\n${ok.length} passed, ${fail.length} failed`);
  if (fail.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
