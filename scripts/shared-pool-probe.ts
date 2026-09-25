/**
 * 0053: a second workspace sees a COMPLETE shared lead — and still cannot touch it, or learn anything
 * about what the first workspace decided.
 *
 *   npx tsx --env-file=.env.local scripts/shared-pool-probe.ts
 *
 * THIS IS THE PROBE THE WIDE 3c EXISTS FOR. Swapping only leads and companies would have left the five
 * dependent tables scoped by ownership, so a second workspace would see a lead stripped of its
 * contacts, its postings, its article — and therefore of its AGE, which is computed from the article's
 * published_at — with an empty Hiring now beside it. That is not dangerous, it is unverifiable: there
 * would be no way to demonstrate the shared pool worked until two more steps landed. So the assertion
 * that matters here is COMPLETENESS, not merely visibility.
 *
 * WHAT IS PROVEN, with two throwaway workspaces signed in as real users. A seeds everything; B is a
 * different workspace that has never touched any of it:
 *
 *   1. B sees A's LEAD and A's COMPANY. The entitlement, at last doing something observable.
 *   2. B sees the whole graph hanging off them — contact, job posting, article, lead_article,
 *      lead_person. Each asserted separately, because each has its own policy and any one of them left
 *      on the old ownership rule would produce a lead that looks present and reads empty.
 *   3. B sees a posting anchored on a COMPANY WITH NO LEAD. 31 of 105 live rows are that shape, all
 *      with a company and none with a lead, so a lead-only rule would drop a third of Hiring now.
 *   4. B CANNOT WRITE any of it — not the lead, not the company, not a contact. `for all` policies
 *      would have handed every entitled workspace UPDATE on the whole pool, so this is the hole the
 *      step could have opened, tested in the direction that would have found it.
 *   5. B LEARNS NOTHING ABOUT A'S ACTIVITY. A marks the lead "not_for_us" and writes a note; B still
 *      reads it as its own untouched lead and sees no note. This is the boundary the entire item
 *      exists for, and the first moment it can be tested on a genuinely SHARED row.
 *   6. B CAN record its own state against A's lead — 3a's visibility rule, now doing real work, since
 *      before 3c there was no lead B could see but not own.
 *   7. An anonymous caller sees none of it.
 *
 * Everything it makes is removed afterwards; a leftover fails the run.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { followAllForProbe, markTest, markWorkspaceTest, removeProbe } from '../src/lib/test-data';

/**
 * The served app, for the screen check at the end.
 *
 * THAT CHECK IS THE REASON THIS PROBE EXISTS IN ITS CURRENT FORM. 0053 made leads readable across
 * workspaces and every SQL assertion here passed — while a brand-new workspace's Leads SCREEN rendered
 * NOTHING, because every lead read joins workspace_lead_state with `!inner` and 0048 had made that table
 * total per lead rather than per (workspace, lead). 0054 fixed the data; this proves the screen.
 *
 * A count from a query is not a screen. That is the whole lesson of 2026-09-25.
 */
const BASE = process.argv[2] ?? 'http://localhost:3100';
const shim = 'globalThis.__name = globalThis.__name || function (f) { return f; };';
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const hydrated = (p: Page) => p.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', undefined, { timeout: 60000 }).catch(() => {});
/** Empty while the page rendered; otherwise WHAT threw, off the boundary itself. */
const boundaryWhy = async (p: Page) => {
  if (await p.locator('[data-error-boundary]').count() === 0) return '';
  const ref = flat(await p.locator('[data-error-reference]').first().innerText().catch(() => ''));
  const said = flat(await p.locator('[data-error-boundary]').first().innerText().catch(() => ''));
  return `error boundary — ${ref || 'no reference'} — ${said.slice(0, 110)}`;
};
/** The company name on each row of the Leads table, in order. */
const leadRows = (p: Page) => p.locator('table.tbl tbody tr').evaluateAll(
  (rows) => rows.map((r) => (r.querySelector('td') as HTMLElement | null)?.innerText?.split('\n')[0]?.trim() ?? ''),
);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const fail: string[] = [];
const ok: string[] = [];
function check(name: string, pass: boolean, detail: string) {
  (pass ? ok : fail).push(`${name} — ${detail}`);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
}

const admin = createClient(url, key, { auth: { persistSession: false } });

async function account(label: string, stamp: number) {
  const email = `shared-pool-${label}+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  return withCreds(label, stamp, email, password);
}

async function withCreds(label: string, stamp: number, email: string, password: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: `Shared Pool ${label}`, agency: `Shared Pool ${label}` } });
  if (error) throw new Error(`could not create account ${label}: ${error.message}`);
  const uid = data.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);
  // Without this a new account is sent to /app/onboarding before any other screen (0032), so the screen
  // check below never reaches Radar and reads an empty table — which is exactly what it did the first
  // time this probe was run against a served app, and it looked identical to the 0054 bug it exists to
  // catch. Every other screen probe in the gate calls this for the same reason.
  await followAllForProbe(admin, uid);
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error: signIn } = await client.auth.signInWithPassword({ email, password });
  if (signIn) throw new Error(`could not sign in as ${label}: ${signIn.message}`);
  // The credentials travel with the account so the screen check can sign the same user in through the
  // real login form rather than inventing a second one.
  return { uid, workspace, client, email, password };
}

const countOf = async (c: any, table: string, col: string, id: string) => {
  const { data, error } = await c.from(table).select(col).eq(col, id);
  if (error) return `error ${error.code}`;
  return (data ?? []).length;
};

async function main() {
  if (!url || !anonKey || !key) { console.error('URL, ANON_KEY and SERVICE_ROLE_KEY are required'); process.exitCode = 1; return; }

  // 0053 not applied yet is "not judged": before it, B sees none of A's rows and every assertion below
  // would fail for the right reason, which is not a useful gate result.
  const probeFn = await (admin as any).rpc('can_see_industries', { row_industries: ['grid'] });
  if (probeFn.error) { console.error(`can_see_industries is not callable — apply 0052 and 0053 first (${probeFn.error.code})`); process.exitCode = 2; return; }

  const stamp = Date.now();
  let A: Awaited<ReturnType<typeof account>> | null = null;
  let B: Awaited<ReturnType<typeof account>> | null = null;

  try {
    A = await account('a', stamp);
    B = await account('b', stamp);

    // ---- A seeds a complete lead: company, lead, contact, posting, article, person ---------------
    // Industries are set on BOTH so the entitlement has something real to judge, rather than passing
    // only through the unclassified escape.
    const { data: co } = await admin.from('companies')
      .insert({ workspace_id: A.workspace, name: `Shared Pool Co ${stamp}`, country: 'DK', employer_type: 'end_client', industries: ['grid'] })
      .select('id').single();
    await markTest(admin, 'companies', [co!.id]);

    // fit_score 99 on purpose: the Leads table shows the top 50 by fit, and the screen check below
    // must find THIS lead on B's screen. Seeded at 0 it would sort behind 229 real leads and the
    // assertion would fail for a reason that has nothing to do with sharing.
    const { data: lead } = await admin.from('leads')
      .insert({ workspace_id: A.workspace, company_id: co!.id, kind: 'won_work', project_name: `Shared Pool Lead ${stamp}`, country: 'DK', industries: ['grid'], fit_score: 99, source_url: `https://example.invalid/shared-${stamp}` })
      .select('id').single();
    await markTest(admin, 'leads', [lead!.id]);

    const { data: contact } = await admin.from('contacts')
      .insert({ lead_id: lead!.id, company_id: co!.id, name: 'Shared Pool Person', title: 'Head of Operations', source_url: `https://example.invalid/shared-${stamp}` })
      .select('id').single();

    // A posting on the LEAD, and a second anchored on the COMPANY ALONE — the 31-row shape.
    const { data: postOnLead } = await admin.from('job_posts')
      .insert({ workspace_id: A.workspace, lead_id: lead!.id, company_id: co!.id, role: 'Welder', status: 'open', source_url: `https://example.invalid/post-lead-${stamp}` })
      .select('id').single();
    const { data: postOnCo } = await admin.from('job_posts')
      .insert({ company_id: co!.id, role: 'Scaffolder', status: 'open', source_url: `https://example.invalid/post-co-${stamp}` })
      .select('id').single();

    const { data: article } = await admin.from('articles')
      .insert({ url: `https://example.invalid/story-${stamp}`, title: 'Shared Pool Story', text: 'A grid contract was awarded.', published_at: new Date(Date.now() - 5 * 86400000).toISOString() })
      .select('id').single();
    await admin.from('lead_articles').insert({ lead_id: lead!.id, article_id: article!.id });

    const { data: person } = await admin.from('people')
      .insert({ workspace_id: A.workspace, name: 'Shared Pool Attendee', company_name: `Shared Pool Co ${stamp}`, source: 'probe' })
      .select('id').single();
    if (person) await admin.from('lead_people').insert({ lead_id: lead!.id, person_id: person.id });

    // ---- 1. B sees the lead and the company -----------------------------------------------------
    check('B sees A\'s LEAD', (await countOf(B.client, 'leads', 'id', lead!.id)) === 1,
      'the entitlement doing something observable for the first time');
    check('B sees A\'s COMPANY', (await countOf(B.client, 'companies', 'id', co!.id)) === 1, 'shared as a fact');

    // ---- 2. and the WHOLE GRAPH, each policy asserted on its own --------------------------------
    check('B sees the lead\'s CONTACT', (await countOf(B.client, 'contacts', 'lead_id', lead!.id)) === 1,
      'contacts (0022) followed the parent — without this the drawer shows a lead with nobody to call');
    check('B sees the lead\'s POSTING', (await countOf(B.client, 'job_posts', 'lead_id', lead!.id)) === 1, 'job_posts (0016) followed');
    check('B sees the LEAD_ARTICLE link', (await countOf(B.client, 'lead_articles', 'lead_id', lead!.id)) === 1, 'lead_articles (0025) followed');
    const { data: bArt } = await B.client.from('articles').select('id, published_at').eq('id', article!.id);
    check('B sees the ARTICLE ITSELF, with its date', (bArt ?? []).length === 1 && !!(bArt ?? [])[0]?.published_at,
      'articles (0025) followed through lead_articles — this is what makes lead AGE computable, so without it every shared lead reads "age unknown"');
    check('B sees the LEAD_PERSON link', (await countOf(B.client, 'lead_people', 'lead_id', lead!.id)) === 1, 'lead_people (0025) followed');

    // ---- 3. the company-anchored posting, the 31-row shape --------------------------------------
    const { data: bCoPost } = await B.client.from('job_posts').select('id, lead_id').eq('id', postOnCo!.id);
    check('B sees a posting anchored on a COMPANY WITH NO LEAD', (bCoPost ?? []).length === 1 && (bCoPost ?? [])[0]?.lead_id === null,
      '31 of 105 live rows are this shape — a lead-only rule would drop a third of Hiring now');

    // ---- 4. and B CANNOT WRITE ANY OF IT --------------------------------------------------------
    // The hole the step could have opened: these were `for all` policies with no WITH CHECK.
    const wLead = await B.client.from('leads').update({ project_name: 'hijacked' }).eq('id', lead!.id);
    const { data: nameNow } = await admin.from('leads').select('project_name').eq('id', lead!.id).single();
    check('B CANNOT rename a shared lead', nameNow?.project_name !== 'hijacked',
      wLead.error ? `refused (${wLead.error.code})` : 'the update reported no error, but the row is unchanged — RLS matched no row to update, which is the same protection');
    const wCo = await B.client.from('companies').update({ name: 'hijacked' }).eq('id', co!.id);
    const { data: coNow } = await admin.from('companies').select('name').eq('id', co!.id).single();
    check('B CANNOT rename a shared company', coNow?.name !== 'hijacked',
      wCo.error ? `refused (${wCo.error.code})` : 'unchanged — no write policy exists for a signed-in caller');
    const wDel = await B.client.from('contacts').delete().eq('id', contact!.id);
    const { count: contactsLeft } = await admin.from('contacts').select('id', { count: 'exact', head: true }).eq('id', contact!.id);
    check('B CANNOT delete a shared contact', contactsLeft === 1,
      wDel.error ? `refused (${wDel.error.code})` : 'still there — for select leaves nothing for a delete to match');

    // ---- 5. AND LEARNS NOTHING ABOUT A'S ACTIVITY ----------------------------------------------
    // The boundary the whole item exists for, testable for the first time on a genuinely shared row.
    const { error: aState } = await A.client.from('workspace_lead_state')
      .update({ status: 'not_for_us', notes: 'A decided against this' })
      .eq('workspace_id', A.workspace).eq('lead_id', lead!.id);
    check('A can mark the shared lead for itself', !aState, aState ? `${aState.code} ${aState.message}` : 'status not_for_us, with a note');

    // Scoped to A'S WORKSPACE, which is the only form of this question that means anything after 0054.
    // Filtering on lead_id alone counts B's OWN row — 0054 gives every workspace one per lead — and the
    // first version of this assertion did exactly that and read as a leak when nothing had leaked.
    const { data: bSeesA } = await B.client.from('workspace_lead_state')
      .select('workspace_id, status, notes').eq('lead_id', lead!.id).eq('workspace_id', A.workspace);
    check("B SEES NO ROW OF A'S", (bSeesA ?? []).length === 0,
      `B reads ${(bSeesA ?? []).length} row(s) carrying A's workspace_id — A marked this lead not_for_us and wrote a note, and B must learn neither`);
    // And nothing with a note ANYWHERE, which catches a leak this lead's id would not.
    const { data: bNotes } = await B.client.from('workspace_lead_state').select('notes').not('notes', 'is', null);
    check("and B sees no note written by anybody", (bNotes ?? []).length === 0,
      `${(bNotes ?? []).length} row(s) with a note visible to B — notes are the most explicitly private field on the table`);

    // B's own reading of the same lead, through its own state row, is untouched by A's decision.
    //
    // 0054 CHANGED WHAT THIS SHOULD SAY. Before it, B had no row at all and the assertion was that it
    // had none. 0054 makes the table total per (WORKSPACE, LEAD) — precisely so B's Leads screen is not
    // empty — so B now HAS a row, created by the workspaces trigger and reading the default 'new'. That
    // is a better statement of the boundary than the old one: the same lead, two rows, two opinions.
    const { data: bOwn } = await B.client.from('workspace_lead_state')
      .select('status, notes').eq('workspace_id', B.workspace).eq('lead_id', lead!.id).maybeSingle();
    check("B HAS its own row on the shared lead, reading 'new'", bOwn?.status === 'new' && bOwn?.notes === null,
      `B reads ${JSON.stringify(bOwn?.status)} with no note, while A reads not_for_us with one — 0054 gave every workspace a row per lead, which is what stops B's Leads screen being empty`);

    // ---- 6. B CAN record its own state — 3a's rule, now doing real work -------------------------
    // An UPDATE, not an insert: 0054 already created the row, so an insert now hits the primary key.
    // That is the path api/lead takes anyway — setLeadState upserts onto an existing row.
    const { error: bWrite } = await B.client.from('workspace_lead_state')
      .update({ status: 'pursue' }).eq('workspace_id', B.workspace).eq('lead_id', lead!.id);
    const { data: bAfter } = await admin.from('workspace_lead_state').select('status').eq('workspace_id', B.workspace).eq('lead_id', lead!.id).maybeSingle();
    check('B CAN record its OWN state against a lead it can see', !bWrite && bAfter?.status === 'pursue',
      bWrite ? `REFUSED: ${bWrite.code} ${bWrite.message} — 0051's visibility rule is not working` : "0051 keyed the WITH CHECK on visibility, and this is the first lead that is visible-but-not-owned, so it is the first time that mattered");
    const { data: aStill } = await admin.from('workspace_lead_state').select('status').eq('workspace_id', A.workspace).eq('lead_id', lead!.id).maybeSingle();
    check("and A's own decision is untouched by B's", aStill?.status === 'not_for_us',
      `A still reads ${JSON.stringify(aStill?.status)} while B reads pursue — one lead, two independent opinions`);

    // ---- 7. anonymous sees none of it ----------------------------------------------------------
    const anonClient = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data: anonLeads } = await anonClient.from('leads').select('id').eq('id', lead!.id);
    const { data: anonCos } = await anonClient.from('companies').select('id').eq('id', co!.id);
    check('an anonymous caller sees neither the lead nor the company', (anonLeads ?? []).length === 0 && (anonCos ?? []).length === 0,
      'can_see_industries denies without a session, which is what stops the pool being public');

    // ================================================================================================
    // 8. THE SCREEN. Everything above passed on 2026-09-25 while this was broken.
    // ================================================================================================
    // 0053 made leads readable across workspaces and every query in this probe agreed — while a
    // brand-new workspace's Leads screen rendered NOTHING, because the read joins workspace_lead_state
    // with `!inner` and 0048 had made that table total per LEAD rather than per (WORKSPACE, LEAD). The
    // SQL was right and the screen was empty. So the decisive assertion is not a count from a query, it
    // is A'S LEAD APPEARING IN B'S TABLE — read off the rendered page, as a recruiter would see it.
    const reachable = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
    if (!reachable) {
      check('the served app is reachable for the screen check', false,
        `nothing answered at ${BASE}/api/health — pass a base url, e.g. scripts/shared-pool-probe.ts http://localhost:3100. The screen check is the point of this probe and is NOT optional`);
    } else {
      const browser = await chromium.launch();
      try {
        const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
        const p = await ctx.newPage();
        await p.addInitScript({ content: shim });
        await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await p.fill('input[type=email]', B.email);
        await p.fill('input[type=password]', B.password);
        await p.click('form button:not([type=button])');
        await p.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});
        check('B signs in to the app', /\/app\//.test(p.url()), p.url().replace(BASE, ''));

        await p.goto(`${BASE}/app/radar?tab=won`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await hydrated(p);
        const why = await boundaryWhy(p);
        check("B's LEADS SCREEN RENDERS", why === '', why || 'no error boundary');

        const rows = await leadRows(p);
        check("B's Leads table is NOT EMPTY", rows.length > 0,
          `${rows.length} row(s) — this read 0 before 0054, with every SQL assertion above passing`);

        // THE ONE THAT MATTERS: a lead created by ANOTHER workspace, on B's screen, by name.
        check("A'S COMPANY IS ON B'S SCREEN", rows.some((r) => r.includes(`Shared Pool Co ${stamp}`)),
          `first rows: ${JSON.stringify(rows.slice(0, 3))} — seeded at fit 99 so it sorts into the top 50`);

        // THE POOL, not just A's one row. "Showing N of M" is a FILTER banner and does not render on the
        // unfiltered view, so counting it was the wrong assertion; what matters is that B's table holds
        // rows from more than one workspace. A row that is neither A's seed nor a test row can only have
        // come from the shared pool, which is the thing 3c set out to build.
        const foreign = rows.filter((r) => r && !r.includes(`Shared Pool Co ${stamp}`));
        check("B's table holds leads from MORE THAN ONE workspace", foreign.length > 0,
          `${rows.length} row(s): A's seed plus ${foreign.length} from the pool, e.g. ${JSON.stringify(foreign.slice(0, 2))}`);
      } finally {
        await browser.close();
      }
    }
  } finally {
    const leftovers: string[] = [];
    // A CLEANUP THAT GIVES UP ON THE FIRST TRANSPORT BLIP FAILS A GATE STEP WHOSE PRODUCT ASSERTIONS ALL PASSED,
    // which is what happened on 2026-09-25: `lead_people: TypeError: fetch failed` reported a leftover after all
    // 23 real checks were green, and the rows had in fact gone with their leads. This probe runs at the END of a
    // gate, which is exactly when the documented connect-exhaustion fault bites, and removeProbe already retries
    // for the same reason. Only a TRANSPORT failure is retried: a Postgres error means the statement reached the
    // database, so repeating it gets the same answer and hides a real fault behind a pause.
    const transient = (m: string) => /fetch failed|ETIMEDOUT|ECONNRESET|UND_ERR|socket hang up|network/i.test(m);
    const absent = (m: string) => /column .* does not exist/i.test(m);
    const attempt = async (label: string, run: () => PromiseLike<{ error: { message: string } | null }>) => {
      for (let i = 1; i <= 3; i++) {
        const { error } = await run();
        if (!error || absent(error.message)) return;
        if (!transient(error.message)) { leftovers.push(`${label}: ${error.message}`); return; }
        if (i === 3) { leftovers.push(`${label}: ${error.message} — still failing after 3 transport attempts`); return; }
        // Printed rather than swallowed: a recovered retry is invisible otherwise, and then a gate log cannot
        // show that connect exhaustion touched this run at all. A silent recovery is still worth knowing about.
        console.log(`     … ${label}: ${error.message} — transport, retrying (${i}/3)`);
        await new Promise((r) => setTimeout(r, 1500 * i));
      }
    };
    // Children first: contacts, job_posts, lead_articles and lead_people reference the lead.
    for (const w of [A?.workspace, B?.workspace].filter(Boolean) as string[]) {
      const read = await admin.from('leads').select('id').eq('workspace_id', w);
      // A FAILED READ HERE USED TO BE SILENT, and it is the worse half of the same bug: an unread error left
      // `ids` empty, every child delete was skipped as "nothing to do", and the cleanup reported itself clean
      // without having looked — the instrument-blindness class this repo has already been bitten by twice.
      if (read.error) leftovers.push(`leads read for cleanup: ${read.error.message}`);
      const ids = (read.data ?? []).map((l: any) => l.id);
      if (ids.length) {
        for (const t of ['lead_people', 'lead_articles', 'contacts', 'job_posts', 'workspace_lead_state'] as const) {
          await attempt(t, () => admin.from(t).delete().in('lead_id', ids));
        }
      }
      for (const t of ['workspace_lead_state', 'workspace_company_state', 'job_posts', 'contacts', 'leads', 'people', 'companies'] as const) {
        await attempt(t, () => admin.from(t).delete().eq('workspace_id', w));
      }
    }
    // Its error was discarded outright before: the probe's own seeded article could survive and nothing said so.
    await attempt('articles', () => admin.from('articles').delete().like('url', 'https://example.invalid/story-%'));
    for (const who of [A, B].filter(Boolean) as NonNullable<typeof A>[]) {
      const left = await removeProbe(admin, who.uid, who.workspace, null, { clearContent: true });
      if (left) leftovers.push(left);
    }
    // The same swallowed-read shape, and the most dangerous instance of it: an unread error here means a FAILED
    // read reports "no is_test workspace remains", so the one assertion that would catch a stranded workspace
    // passes precisely when it could not look. It must say it could not look instead.
    const still = await admin.from('workspaces').select('name').eq('is_test', true);
    if (still.error) leftovers.push(`could not check for stranded is_test workspaces: ${still.error.message}`);
    else if (still.data.length) leftovers.push(`is_test workspaces remain: ${still.data.map((w: any) => w.name).join(', ')}`);
    check('the probe cleans up after itself', !leftovers.length, leftovers.length ? leftovers.join('; ') : 'both workspaces, the shared graph and the article are gone');
  }

  console.log(`\n${ok.length} passed, ${fail.length} failed`);
  if (fail.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
