/**
 * Item 39: a posting already on file is REFRESHED, never discarded — and never reassigned.
 *
 *   npx tsx --env-file=.env.local scripts/posting-write-check.ts
 *
 * `job_posts` carries TWO unique indexes — (company_id, source_url) from 0006 and **source_url ALONE** from
 * 0014 — and the crawl's upsert targets the first. So a URL already on file under ANOTHER company violated
 * the second and the write was refused with 23505: the posting was DROPPED and the run carried on. Seven were
 * lost in item 32's re-read, and every one was a pair of company rows for a single firm (VESTAS / Vestas
 * Manufacturing sharing one careers_url, Nadara / renantis either side of a rebrand, two misspellings of
 * Fläminger). That is why the fix is NOT `onConflict: 'source_url'`: conflicting on the URL alone overwrites
 * company_id, so each crawl would move the advert to whichever duplicate ran last, and with both rows live
 * and both crawled the owner would FLAP every cycle. A visible refusal would have become a silent oscillation.
 *
 * THREE ARMS, BECAUSE ONE OF THEM IS THE WHOLE POINT:
 *   1. a brand-new URL is inserted
 *   2. the SAME company re-crawling its own advert updates it in place
 *   3. a DIFFERENT company meeting a URL already on file refreshes the row and LEAVES OWNERSHIP ALONE
 * Arm 3 asserts both halves separately — the fields moved AND company_id did not — because a function that
 * silently did nothing at all would satisfy "ownership unchanged" on its own.
 *
 * Writes only inside its own is_test workspace, and removes it afterwards. No model call, no spend.
 */
import { writePosting } from '../src/lib/jobs/job-posts-batch';
import { probeAdmin, markWorkspaceTest, removeProbe } from '../src/lib/test-data';

const db = probeAdmin();
let fail = 0;
const check = (name: string, pass: boolean, detail: string) => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!pass) fail++;
};

const URL_NEW = `https://example.invalid/posting-write-check/new-${Date.now()}`;
const URL_SHARED = `https://example.invalid/posting-write-check/shared-${Date.now()}`;

(async () => {
  let ws: string | null = null;
  try {
    const { data: w, error: wErr } = await db.from('workspaces')
      .insert({ name: `Posting Write Check ${Date.now()}`, slug: `posting-write-check-${Date.now()}` }).select('id').single();
    if (wErr || !w) throw new Error(`the test workspace could not be created: ${wErr?.message}`);
    ws = w.id as string;
    await markWorkspaceTest(db, ws);

    // TWO company rows standing for the duplicate pair the live data actually has.
    const mk = async (name: string) => {
      const { data, error } = await db.from('companies').insert({ name, workspace_id: ws }).select('id').single();
      if (error || !data) throw new Error(`${name} could not be created: ${error?.message}`);
      return data.id as string;
    };
    const first = await mk(`PWC Alpha ${Date.now()}`);
    const second = await mk(`PWC Alpha Manufacturing ${Date.now()}`);

    const row = (companyId: string, url: string, role: string, extra: Record<string, any> = {}) => ({
      company_id: companyId, workspace_id: ws, source_url: url, role,
      status: 'open', trades: ['welder'], last_seen_at: new Date().toISOString(), ...extra,
    });

    // ---- ARM 1: a brand-new URL is inserted.
    const a1 = await writePosting(db, row(first, URL_NEW, 'PWC Welder'));
    check('a new URL is written', a1.outcome === 'written', a1.outcome === 'written' ? 'inserted' : `got ${a1.outcome} — ${(a1 as any).error ?? ''}`);
    const { data: afterA1 } = await db.from('job_posts').select('id, company_id, role').eq('source_url', URL_NEW).maybeSingle();
    check('and it belongs to the company that wrote it', afterA1?.company_id === first, `owner=${afterA1?.company_id === first ? 'first' : String(afterA1?.company_id)}`);

    // ---- ARM 2: the SAME company re-crawls its own advert. The row must be updated, not duplicated.
    const a2 = await writePosting(db, row(first, URL_NEW, 'PWC Welder — retitled'));
    check('the same company re-crawling its own advert succeeds', a2.outcome === 'written', `got ${a2.outcome}`);
    const { data: sameRows } = await db.from('job_posts').select('id, role').eq('source_url', URL_NEW);
    check('it is still ONE row', (sameRows ?? []).length === 1, `${(sameRows ?? []).length} row(s)`);
    check('and the row carries the NEW reading', sameRows?.[0]?.role === 'PWC Welder — retitled',
      `role="${sameRows?.[0]?.role}"`);

    // ---- ARM 3: the duplicate company meets a URL the first one already holds. THE REGRESSION ARM.
    await writePosting(db, row(first, URL_SHARED, 'PWC Shared Advert', { location: 'Esbjerg', last_seen_at: '2026-01-01T00:00:00.000Z' }));
    const { data: before } = await db.from('job_posts').select('id, company_id, role, location, last_seen_at').eq('source_url', URL_SHARED).maybeSingle();
    check('the shared advert starts out owned by the first company', before?.company_id === first, `owner=${before?.company_id === first ? 'first' : String(before?.company_id)}`);

    const a3 = await writePosting(db, row(second, URL_SHARED, 'PWC Shared Advert — fresher', { location: 'Aalborg' }));
    // THE OLD BEHAVIOUR WAS A 23505 HERE. This is the assertion that fails if anyone restores it.
    check('a DIFFERENT company meeting the same URL is NOT refused', a3.outcome === 'refreshed_elsewhere',
      a3.outcome === 'refreshed_elsewhere' ? 'refreshed in place' : `got ${a3.outcome} — ${(a3 as any).error ?? ''}`);
    check('and it names the company that holds it', a3.outcome === 'refreshed_elsewhere' && a3.ownerId === first,
      a3.outcome === 'refreshed_elsewhere' ? `ownerId=${a3.ownerId === first ? 'first' : a3.ownerId}` : 'no ownerId');

    const { data: after } = await db.from('job_posts').select('id, company_id, role, location, last_seen_at').eq('source_url', URL_SHARED).maybeSingle();
    // BOTH HALVES, SEPARATELY. A function that did nothing at all would pass "ownership unchanged" alone.
    check('OWNERSHIP IS UNCHANGED — the duplicate did not steal the advert', after?.company_id === first,
      after?.company_id === first ? 'still the first company' : `MOVED to ${String(after?.company_id)} — this is the flap this fix exists to prevent`);
    check('the row WAS refreshed — the new reading landed', after?.role === 'PWC Shared Advert — fresher' && after?.location === 'Aalborg',
      `role="${after?.role}" location="${after?.location}"`);
    check('last_seen_at moved forward', !!after?.last_seen_at && after.last_seen_at > '2026-01-01T00:00:00.000Z',
      `last_seen_at=${after?.last_seen_at}`);
    const { data: stillOne } = await db.from('job_posts').select('id').eq('source_url', URL_SHARED);
    check('and no second row was created for that URL', (stillOne ?? []).length === 1, `${(stillOne ?? []).length} row(s)`);
  } catch (e: any) {
    fail++;
    console.log(`FAIL  the check could not run — ${String(e?.message ?? e).slice(0, 200)}`);
  } finally {
    if (ws) {
      // ITS OWN ROWS FIRST, IN FOREIGN-KEY ORDER. `removeProbe`'s clearContent deliberately does not touch
      // `companies`, so the workspace delete would hit companies_workspace_id_fkey and strand the workspace —
      // the exact shape that left nine of them behind on 2026-10-01. Both deletes read their error.
      const { error: pErr } = await db.from('job_posts').delete().eq('workspace_id', ws);
      if (pErr) { fail++; console.log(`FAIL  cleanup — the postings could not be removed: ${pErr.message}`); }
      const { error: cErr } = await db.from('companies').delete().eq('workspace_id', ws);
      if (cErr) { fail++; console.log(`FAIL  cleanup — the companies could not be removed: ${cErr.message}`); }
      const left = await removeProbe(db, null, ws, null);
      if (left) { fail++; console.log(`FAIL  cleanup — ${left}`); }
    }
  }
  console.log(`\nposting write: ${fail ? `${fail} FAILED` : 'all checks passed'}`);
  process.exitCode = fail ? 1 : 0;
})();
