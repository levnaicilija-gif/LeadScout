/**
 * Item 24 step 2 on screen: the candidate list — table and kanban on the same rows, boolean search, filters, stage moves —
 * as a signed-in recruiter at 1500px and at 390px on a touch screen, drag-and-drop included. Needs 0035.
 *
 *   npx tsx --env-file=.env.local scripts/candidate-list-probe.ts https://leadscout-rfbt.vercel.app
 *
 * In a throwaway test workspace it seeds six made-up candidates (four owned by the probe, two by nobody), certificates,
 * and a CV sent to Semco Maritime. Then:
 *   1. 1500px table: all six listed with #N and the code; a boolean search finds exactly the right ones and reads the
 *      query back; a malformed search says where it went wrong; Mine shows only the probe's four.
 *   2. The table's stage picker moves one candidate to Screening — the database records the stage, who and when.
 *   3. 1500px kanban: dragging a card to Placed asks for client and date, and records AIBEL with placed_by and placed_at;
 *      the card is in the Placed column; "currently placed at aibel" finds exactly that candidate.
 *   4. 390px kanban: the card's picker moves them to Bench, which asks when the placement ended and records it.
 *   5. Neither view scrolls the page sideways at either width.
 * Everything it made is removed afterwards; a leftover fails the run.
 */
import { createClient } from '@supabase/supabase-js';
import { chromium, type Page } from 'playwright';
import { followAllForProbe, markWorkspaceTest, removeProbe, probeAdmin } from '../src/lib/test-data';
import { hasCandidateCrm } from '../src/lib/schema-features';
import { candidateLabel } from '../src/lib/candidate-number';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const EMAIL = `candidate-list-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = `probe-${Date.now()}-0123456789`;
const admin = probeAdmin();

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };
const sideways = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const hydrated = (p: Page) => p.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', undefined, { timeout: 60000 }).catch(() => {});
const today = new Date().toISOString().slice(0, 10);

(async () => {
  if (!(await hasCandidateCrm(admin))) { console.log('0035 is not applied — stages, preferences and placements do not exist yet, so the list probe cannot run'); process.exit(1); }
  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Candidate List Probe', agency: 'Candidate List Probe' } });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);
  await admin.from('users').update({ role: 'recruiter', onboarding_day: 30 }).eq('id', uid);
  await followAllForProbe(admin, uid);

  // Letters only before the number, so the code's number is its trailing digits whether or not 0036 is applied.
  const tag = Date.now().toString().slice(-5).replace(/\d/g, (d) => 'ABCDEFGHIJ'[Number(d)]);
  const seed = [
    { key: 'lars', full_name: 'Probe Lars Nilsen', trade: 'Welder', country: 'Norway', employment_preference: 'contract', owner_id: uid },
    { key: 'ana', full_name: 'Probe Ana Popescu', trade: 'Welder', country: 'Denmark', employment_preference: 'permanent', owner_id: uid },
    { key: 'jan', full_name: 'Probe Jan de Vries', trade: 'NDT inspector', country: 'Netherlands', employment_preference: 'either', owner_id: uid },
    { key: 'marko', full_name: 'Probe Marko Jovanović', trade: 'Painter', country: 'Norway', employment_preference: 'contract', owner_id: uid },
    { key: 'piotr', full_name: 'Probe Piotr Kowalski', trade: 'Welder', country: 'Poland', employment_preference: 'contract', owner_id: null },
    { key: 'sven', full_name: 'Probe Sven Hansen', trade: 'Scaffolder', country: 'Denmark', employment_preference: 'either', owner_id: null },
  ];
  const rows = seed.map((s, i) => ({ workspace_id: workspace, reference_code: `PROBE${tag}-X-${String(9000 + i)}`, trade_code: 'X', full_name: s.full_name, trade: s.trade, country: s.country, employment_preference: s.employment_preference, owner_id: s.owner_id, stage: 'new', created_via: 'manual', is_test: true }));
  const { data: inserted, error: insErr } = await admin.from('candidates').insert(rows).select('id, reference_code, full_name');
  if (insErr) { console.error('seeding failed:', insErr.message); await removeProbe(admin, uid, workspace, null, { clearContent: true }); process.exit(1); }
  const idOf = (key: string) => inserted!.find((r: any) => r.full_name === seed.find((s) => s.key === key)!.full_name)!;
  await admin.from('documents').insert([
    { candidate_id: idOf('marko').id, workspace_id: workspace, type: 'certificate', cert_body: 'frosio', storage_path: `list-probe/${tag}-1`, extracted: { level: 'III', number: '12345' }, is_test: true },
    { candidate_id: idOf('lars').id, workspace_id: workspace, type: 'certificate', cert_body: 'iso9606', storage_path: `list-probe/${tag}-2`, extracted: { number: '777' }, is_test: true },
  ]);
  await admin.from('sends').insert({ candidate_id: idOf('ana').id, sent_by: uid, sent_at: new Date().toISOString(), client_name: 'Semco Maritime' });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || function (f) { return f; };' });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 }).catch(() => {});

    // ---- 1. table, search, Mine
    await page.goto(`${BASE}/app/candidates`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);
    const listed = await page.locator('[data-candidate-row]').count();
    const firstRow = await page.locator(`[data-candidate-row="${idOf('lars').id}"]`).innerText().catch(() => '');
    check(listed === 6 && firstRow.includes(candidateLabel(idOf('lars').reference_code)) && firstRow.includes(idOf('lars').reference_code), 'at 1500px the table lists all six, each with #N and its code', `${listed} rows · ${firstRow.replace(/\s+/g, ' ').slice(0, 120)}`);
    const search = async (p: Page, q: string) => { await p.goto(`${BASE}/app/candidates?q=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded', timeout: 60000 }); await hydrated(p); return p.locator('[data-candidate-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-candidate-row'))); };
    const welders = await search(page, 'welder AND (norway OR denmark) AND NOT poland');
    const understood = await page.locator('[data-search-understood]').innerText().catch(() => '');
    check(welders.length === 2 && welders.includes(idOf('lars').id) && welders.includes(idOf('ana').id), 'a boolean search finds exactly the Norwegian and Danish welders', `${welders.length} found · ${understood}`);
    check(/Searching for welder AND \(norway OR denmark\) AND NOT poland/.test(understood), 'the search is read back the way it was understood', understood);
    const semco = await search(page, '"sent to semco"');
    check(semco.length === 1 && semco[0] === idOf('ana').id, 'client history is searchable: the CV sent to Semco Maritime', `${semco.length} found`);
    const frosio = await search(page, 'frosio AND "level iii"');
    check(frosio.length === 1 && frosio[0] === idOf('marko').id, 'certificates are searchable', `${frosio.length} found`);
    await search(page, '(welder');
    const bad = await page.locator('[data-search-error]').innerText().catch(() => '');
    check(/never closed/.test(bad) && (await page.locator('[data-candidate-row]').count()) === 0, 'a malformed search says where it went wrong instead of showing an empty result', bad);
    await page.goto(`${BASE}/app/candidates?mine=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    check((await page.locator('[data-candidate-row]').count()) === 4, 'Mine shows only the four the probe owns');
    check(await sideways(page) <= 1, 'at 1500px the table does not scroll the page sideways', `${await sideways(page)}px`);

    // ---- 2. the table's stage picker
    await page.goto(`${BASE}/app/candidates`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);
    await page.selectOption(`[data-stage-select="${idOf('jan').id}"]`, 'screening');
    await page.waitForTimeout(500);
    let jan: any = null;
    for (let i = 0; i < 20 && jan?.stage !== 'screening'; i++) { ({ data: jan } = await admin.from('candidates').select('stage, stage_changed_by, stage_changed_at').eq('id', idOf('jan').id).single()); if (jan?.stage !== 'screening') await page.waitForTimeout(500); }
    check(jan?.stage === 'screening' && jan.stage_changed_by === uid && !!jan.stage_changed_at, 'the table moves a candidate to Screening, and records who and when', JSON.stringify(jan));

    // ---- 3. kanban drag to Placed
    await page.goto(`${BASE}/app/candidates?view=kanban`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(page);
    const card = page.locator(`[data-kanban-card="${idOf('marko').id}"]`);
    await card.dragTo(page.locator('[data-kanban-column="placed"]'));
    const dialog = page.locator('[data-stage-dialog="placement"]');
    check(await dialog.isVisible().catch(() => false), 'at 1500px dragging a card to Placed asks for the client and the date');
    await page.fill('[data-placement-client]', 'AIBEL');
    await page.fill('[data-placement-date]', today);
    await page.click('[data-stage-confirm]');
    await page.waitForSelector('[data-stage-dialog]', { state: 'detached', timeout: 30000 }).catch(() => {});
    const { data: placement } = await admin.from('candidate_placements').select('client_name, placed_on, ended_on, placed_by, placed_at').eq('candidate_id', idOf('marko').id);
    const { data: marko } = await admin.from('candidates').select('stage').eq('id', idOf('marko').id).single();
    check((placement ?? []).length === 1 && placement![0].client_name === 'AIBEL' && placement![0].placed_on === today && placement![0].placed_by === uid && !!placement![0].placed_at && marko?.stage === 'placed', 'the placement is recorded — AIBEL, the date, placed_by and placed_at — and the stage is Placed', JSON.stringify({ placement, stage: marko?.stage }));
    const inPlaced = await page.locator('[data-kanban-column="placed"] [data-kanban-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kanban-card')));
    check(inPlaced.includes(idOf('marko').id), 'the card is in the Placed column');
    check(await sideways(page) <= 1, 'at 1500px the kanban does not scroll the page sideways', `${await sideways(page)}px`);
    const atAibel = await search(page, '"currently placed at aibel"');
    check(atAibel.length === 1 && atAibel[0] === idOf('marko').id, '"currently placed at AIBEL" finds exactly that candidate', `${atAibel.length} found`);

    // ---- 4. 390px: move out of Placed with the card's picker, which ends the placement
    const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const m = await phone.newPage();
    await m.addInitScript({ content: 'globalThis.__name = globalThis.__name || function (f) { return f; };' });
    await m.goto(`${BASE}/app/candidates?view=kanban`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await hydrated(m);
    check(await sideways(m) <= 1, 'at 390px the kanban scrolls inside its own frame, not the page', `${await sideways(m)}px`);
    await m.locator(`[data-kanban-card="${idOf('marko').id}"] [data-stage-select]`).selectOption('bench');
    const endDialog = m.locator('[data-stage-dialog="end"]');
    check(await endDialog.isVisible().catch(() => false), 'at 390px moving someone out of Placed asks when the placement ended');
    await m.fill('[data-placement-end]', today);
    await m.locator('[data-stage-confirm]').tap();
    await m.waitForSelector('[data-stage-dialog]', { state: 'detached', timeout: 30000 }).catch(() => {});
    const { data: ended } = await admin.from('candidate_placements').select('ended_on').eq('candidate_id', idOf('marko').id);
    const { data: benched } = await admin.from('candidates').select('stage').eq('id', idOf('marko').id).single();
    check(ended?.[0]?.ended_on === today && benched?.stage === 'bench', 'the placement ends on that date and the stage is Bench', JSON.stringify({ ended, stage: benched?.stage }));
    await m.goto(`${BASE}/app/candidates?q=welder`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    check((await m.locator('[data-candidate-row]').count()) === 3 && await sideways(m) <= 1, 'at 390px the table searches and scrolls inside its own frame', `${await sideways(m)}px`);
    await phone.close();
  } finally {
    await browser.close();
    const leftBehind = await removeProbe(admin, uid, workspace, null, { clearContent: true });
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); } else console.log('\nprobe user, its workspace and every seeded row removed');
  }
  console.log(failures === 0 ? 'candidate list probe: all checks passed' : `candidate list probe: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
