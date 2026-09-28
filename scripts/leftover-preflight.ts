/**
 * Gate step 0: is a probe workspace stranded in the real project BEFORE anything runs?
 *
 * WHY THIS IS THE FIRST STEP AND NOT THE LAST. Three probes — entitlement, state-write-visibility and
 * shared-pool — already assert "no is_test workspace remains" in their own cleanup, so a leftover DOES
 * fail the gate. It just fails it forty minutes in, three times over, naming a workspace none of them
 * created. On 2026-09-26 that cost a full run: a probe that threw before its cleanup (a deliberate
 * mutation test) and a smoke step that threw on a transport blip each stranded one, and the next gate
 * reported three red steps whose real cause was two rows left over from the previous hour.
 *
 * CLAUDE.md has said "check for is_test workspaces before starting again" since 2026-09-15. This is that
 * instruction as a step rather than as a habit, because the habit was the thing that failed.
 *
 * It refuses rather than cleans. A stranded workspace is evidence: it says which probe died and roughly
 * when, and deleting it automatically would erase that while also handing a script the power to remove
 * workspaces nobody asked it to. The message names each one, its age and what it holds, so the decision
 * is a person's.
 *
 * Exit 0 clean, 1 with leftovers, 1 if it cannot tell — a check that cannot look must never read clean.
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

(async () => {
  if (!url || !key) { console.error('URL and SERVICE_ROLE_KEY are required'); process.exitCode = 1; return; }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const ws = await db.from('workspaces').select('id, name, is_test, created_at');
  if (ws.error) {
    // The is_test column arrives with 0020; before it there is nothing to check and that is not a failure.
    if (ws.error.code === '42703' || /column .* does not exist/i.test(ws.error.message)) {
      console.log('is_test is not on workspaces yet (0020) — nothing to check');
      return;
    }
    console.error(`could not read workspaces, so this check cannot say the project is clean: ${ws.error.message}`);
    process.exitCode = 1;
    return;
  }

  const strays = ws.data.filter((w: any) => w.is_test);
  if (!strays.length) {
    console.log(`clean — ${ws.data.length} workspace(s), none marked is_test`);
    return;
  }

  console.error(`${strays.length} probe workspace(s) stranded in the real project. A gate started now would fail three probes with this as the cause:`);
  for (const w of strays) {
    const mins = Math.round((Date.now() - new Date(w.created_at).getTime()) / 60000);
    const held: string[] = [];
    const us = await db.from('users').select('id, name, role').eq('workspace_id', w.id);
    if (us.error) held.push(`users: could not read (${us.error.message})`);
    else if (us.data.length) held.push(`users: ${us.data.map((u: any) => `${u.name ?? '?'}/${u.role ?? '?'}`).join(', ')}`);
    for (const t of ['companies', 'leads', 'job_posts', 'contacts', 'candidates', 'documents', 'outreach', 'cost_log', 'workspace_lead_state', 'workspace_company_state'] as const) {
      const r = await db.from(t).select('*', { count: 'exact', head: true }).eq('workspace_id', w.id);
      if (!r.error && (r.count ?? 0) > 0) held.push(`${t}: ${r.count}`);
    }
    console.error(`  "${w.name}"  ${w.id}  created ${mins} minute(s) ago — ${held.join('; ') || 'nothing'}`);
  }
  // THE ADVICE NAMES THE REAL ORDER, because the old advice did not work (2026-09-28). It said "remove them
  // with removeProbe", which CANNOT: removeProbe's clearContent deliberately does not touch `leads` or
  // `companies`, so the workspace delete is then blocked by companies_workspace_id_fkey, and clearing
  // companies is itself blocked by contacts_company_id_fkey. Followed literally at 3am it fails twice and
  // tells you neither reason. Two traps inside that order, both met for real: `contacts` has NO
  // workspace_id column and must go by company_id, and `job_posts` needs company_id too because its
  // workspace_id can be null (the writer gap fixed in eb64fd2 left 37 such rows).
  console.error('Remove them in this order — removeProbe alone CANNOT do it, because clearContent leaves leads and companies behind:');
  console.error('  1. workspace_lead_state     .eq(workspace_id)');
  console.error('  2. workspace_company_state  .eq(workspace_id)');
  console.error('  3. leads                    .eq(workspace_id)');
  console.error('  4. contacts                 .in(company_id, <the workspace’s company ids>)   — contacts has no workspace_id');
  console.error('  5. job_posts                .in(company_id, <same>)                          — its workspace_id can be null');
  console.error('  6. companies                .eq(workspace_id)');
  console.error('  7. removeProbe(db, userId, workspaceId, null, { clearContent: true }) for each user — it detaches cost_log,');
  console.error('     which otherwise blocks the delete. A workspace with no users can be deleted directly at this point.');
  console.error('Read every delete’s error: a silent failure here leaves the next step blocked and the workspace stranded again.');
  process.exitCode = 1;
})();
