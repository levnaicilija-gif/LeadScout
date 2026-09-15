/**
 * Item 24: the boolean search at the scale the pool is heading for, through the real read path.
 *
 *   npx tsx --env-file=.env.local scripts/candidate-pool-scale.ts [--count 2500]
 *
 * Fills a throwaway test workspace with synthetic candidates (a fixed seed, every name made up, every row is_test):
 * certificates with a verification, CV-sent rows, and placements when 0035 is applied. Then, signed in as that workspace's
 * own user — so row-level security and paging are in the measurement — times loadPool (the database read) and filterPool
 * (the search) for six queries, and checks each answer against a filter written independently over the same seeded records.
 * Everything it made is removed afterwards; a leftover fails the run. Never touches the real workspace.
 */
import { createClient } from '@supabase/supabase-js';
import { loadPool, filterPool } from '../src/lib/candidate-pool';
import { markWorkspaceTest, removeProbe } from '../src/lib/test-data';
import { hasCandidateCrm } from '../src/lib/schema-features';

const COUNT = Number(process.argv[process.argv.indexOf('--count') + 1]) || 2500;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const EMAIL = `candidate-scale-probe+${Date.now()}@rfbt-recruitment.com`;
const PASSWORD = `probe-${Date.now()}-0123456789`;

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };

let seed = 24091515;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const TRADES = ['Painter', 'Blaster', 'Welder', 'Pipefitter', 'Scaffolder', 'Insulator', 'Electrician', 'Rope access technician', 'NDT inspector', 'Plate fitter'];
const COUNTRIES = ['Norway', 'Denmark', 'Poland', 'Romania', 'Serbia', 'Portugal', 'Spain', 'Netherlands', 'Germany', 'United Kingdom'];
const CERTS = [['frosio', 'II'], ['frosio', 'III'], ['cswip', '3.1'], ['pcn', '2'], ['iso9606', null], ['irata', '2'], ['ampp', '2'], ['cisrs', 'advanced']] as const;
const PREFS = ['permanent', 'contract', 'either'] as const;
const STAGES = ['new', 'screening', 'presented', 'placed', 'bench'] as const;
const CLIENTS = ['AIBEL', 'Semco Maritime', 'Aker Solutions', 'Kvaerner', 'Bladt Industries', 'Damen', 'Worley', 'Ørsted', 'Vestas', 'Equinor'];
const FIRST = ['Marko', 'Ana', 'Lars', 'Jan', 'Piotr', 'Ionuț', 'João', 'Miguel', 'Sven', 'Dragan', 'Tomasz', 'Mihai'];
const LAST = ['Jovanović', 'Popescu', 'Nilsen', 'de Vries', 'Kowalski', 'Ionescu', 'Silva', 'García', 'Hansen', 'Petrović', 'Nowak', 'Dumitru'];

type Seeded = { ref: string; trade: string; country: string; certs: string[]; pref: string; stage: string; notes: string; sentTo: string[]; placedAt: string | null };

(async () => {
  const crm = await hasCandidateCrm(admin);
  console.log(`seeding ${COUNT} synthetic candidates${crm ? ' (0035 applied: stages, preferences, placements)' : ' (0035 not applied: no stages, preferences or placements)'}`);
  const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { name: 'Candidate Scale Probe', agency: 'Candidate Scale Probe' } });
  if (error) { console.error('could not create the probe user:', error.message); process.exit(1); }
  const uid = created.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);

  const seeded: Seeded[] = [];
  try {
    // Candidates, in chunks.
    // Letters only before the number: 0035 read every digit in a code as the number (fixed by 0036).
    const runTag = `SCALE${Date.now().toString().slice(-6).replace(/\d/g, (d) => 'ABCDEFGHIJ'[Number(d)])}`;
    for (let i = 0; i < COUNT; i += 500) {
      const chunk = Array.from({ length: Math.min(500, COUNT - i) }, (_, k) => {
        const n = i + k;
        const s: Seeded = {
          ref: `${runTag}-X-${String(n).padStart(5, '0')}`, trade: pick(TRADES), country: pick(COUNTRIES),
          certs: [], pref: pick(PREFS), stage: pick(STAGES), notes: rnd() < 0.2 ? 'not available until spring' : rnd() < 0.5 ? 'offshore experience, own tools' : '',
          sentTo: Array.from({ length: Math.floor(rnd() * 3) }, () => pick(CLIENTS)), placedAt: null,
        };
        if (crm && s.stage === 'placed') s.placedAt = pick(CLIENTS);
        seeded.push(s);
        return {
          workspace_id: workspace, reference_code: s.ref, trade_code: 'X', full_name: `${pick(FIRST)} ${pick(LAST)}`, trade: s.trade,
          internal_notes: s.notes || null, created_via: 'import', is_test: true,
          ...(crm ? { country: s.country, employment_preference: s.pref, stage: s.stage, owner_id: uid } : { nationality: null }),
        };
      });
      const { error: e } = await admin.from('candidates').insert(chunk);
      if (e) throw new Error(`seeding candidates failed: ${e.message}`);
    }
    // Paged: one read returns at most 1,000 rows. The first version read the ids once, so 1,500 of 2,500 candidates had no
    // id, their certificates and CV-sent rows were written pointing at nobody, and the orphaned CV-sent rows blocked cleanup.
    const idOf = new Map<string, string>();
    for (let from = 0; ; from += 1000) {
      const { data: page, error: idErr } = await admin.from('candidates').select('id, reference_code').eq('workspace_id', workspace).order('id').range(from, from + 999);
      if (idErr) throw new Error(`reading seeded ids failed: ${idErr.message}`);
      for (const r of page ?? []) idOf.set(r.reference_code, r.id);
      if (!page || page.length < 1000) break;
    }
    const missing = seeded.filter((s) => !idOf.get(s.ref)).length;
    if (missing) throw new Error(`${missing} seeded candidates have no id — nothing is written that would point at nobody`);

    // Certificates with a verification, CV-sent rows and placements.
    const docs: any[] = [], sends: any[] = [], placements: any[] = [];
    for (const s of seeded) {
      const cid = idOf.get(s.ref);
      for (let k = 0; k < 1 + Math.floor(rnd() * 2); k++) {
        const [body, level] = pick(CERTS);
        s.certs.push(`${body}${level ? ` ${level}` : ''}`);
        docs.push({ candidate_id: cid, workspace_id: workspace, type: 'certificate', cert_body: body, storage_path: `scale-probe/${s.ref}-${k}`, extracted: { level, number: String(100000 + Math.floor(rnd() * 900000)) }, is_test: true });
      }
      for (const client of s.sentTo) sends.push({ candidate_id: cid, sent_by: uid, sent_at: new Date().toISOString(), ...(crm ? { client_name: client } : {}) });
      if (s.placedAt) placements.push({ workspace_id: workspace, candidate_id: cid, client_name: s.placedAt, placed_on: '2026-09-01', placed_by: uid });
    }
    for (let i = 0; i < docs.length; i += 1000) { const { error: e } = await admin.from('documents').insert(docs.slice(i, i + 1000)); if (e) throw new Error(`seeding documents failed: ${e.message}`); }
    if (crm) for (let i = 0; i < sends.length; i += 1000) { const { error: e } = await admin.from('sends').insert(sends.slice(i, i + 1000)); if (e) throw new Error(`seeding sends failed: ${e.message}`); }
    if (crm) for (let i = 0; i < placements.length; i += 1000) { const { error: e } = await admin.from('candidate_placements').insert(placements.slice(i, i + 1000)); if (e) throw new Error(`seeding placements failed: ${e.message}`); }
    console.log(`seeded ${seeded.length} candidates, ${docs.length} certificates, ${crm ? sends.length : 0} CV-sent rows, ${placements.length} placements`);

    // Read as the workspace's own user: RLS and paging included.
    const user = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    const { error: signInError } = await user.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
    if (signInError) throw new Error(`sign-in failed: ${signInError.message}`);
    const loads: number[] = [];
    let pool = await loadPool(user, crm);
    for (let r = 0; r < 3; r++) { const p = await loadPool(user, crm); loads.push(p.ms); pool = p; }
    // What the read costs without each certificate's verifications — to decide, with numbers, whether the list needs them.
    const light: number[] = [];
    for (let r = 0; r < 3; r++) {
      const t = Date.now();
      const { count } = await user.from('candidates').select('id', { count: 'exact', head: true });
      await Promise.all(Array.from({ length: Math.ceil((count ?? 0) / 1000) }, (_, i) => user.from('candidates').select('id, reference_code, full_name, trade, nationality, availability_from, created_by, created_at, internal_notes, stage, employment_preference, country, owner_id, documents!candidate_id(type, cert_body, level:extracted->>level, number:extracted->>number), sends(sent_at, client_name, companies(name)), candidate_placements(client_name, placed_on, ended_on)').order('created_at', { ascending: false }).order('id').range(i * 1000, i * 1000 + 999)));
      light.push(Date.now() - t);
    }
    console.log(`  ...  the same read without certificate verifications: ${light.join(' / ')} ms`);
    // And the candidates alone — no certificates, CV-sent rows or placements: the floor a stored search column could reach.
    const flat: number[] = [];
    for (let r = 0; r < 3; r++) {
      const t = Date.now();
      const { count } = await user.from('candidates').select('id', { count: 'exact', head: true });
      await Promise.all(Array.from({ length: Math.ceil((count ?? 0) / 1000) }, (_, i) => user.from('candidates').select('id, reference_code, full_name, trade, nationality, availability_from, created_by, created_at, internal_notes, stage, employment_preference, country, owner_id').order('created_at', { ascending: false }).order('id').range(i * 1000, i * 1000 + 999)));
      flat.push(Date.now() - t);
    }
    console.log(`  ...  the candidates alone, no certificates, CV-sent rows or placements: ${flat.join(' / ')} ms`);
    // Option 1 for the owner: the same data as four flat reads — candidates, their certificates, CVs sent, placements — every
    // page of every table at once, joined in memory. Measured, not shipped.
    const paged = async (table: string, cols: string, narrow: (q: any) => any = (q) => q) => {
      const { count } = await narrow(user.from(table).select('id', { count: 'exact', head: true }));
      const pages = await Promise.all(Array.from({ length: Math.ceil((count ?? 0) / 1000) }, (_, i) => narrow(user.from(table).select(cols)).order('id').range(i * 1000, i * 1000 + 999)));
      return pages.flatMap((p: any) => p.data ?? []);
    };
    const split: number[] = [];
    let joinedCerts = 0;
    for (let r = 0; r < 3; r++) {
      const t = Date.now();
      const [cs, ds, ss, ps] = await Promise.all([
        paged('candidates', 'id, reference_code, full_name, trade, nationality, availability_from, created_by, created_at, internal_notes, stage, employment_preference, country, owner_id'),
        paged('documents', 'candidate_id, type, cert_body, level:extracted->>level, number:extracted->>number, verifications(valid_until, state, checked_at)', (q) => q.not('candidate_id', 'is', null)),
        paged('sends', 'candidate_id, sent_at, client_name, companies(name)'),
        paged('candidate_placements', 'candidate_id, client_name, placed_on, ended_on'),
      ]);
      const byCand = new Map<string, any[]>();
      for (const d of ds) (byCand.get(d.candidate_id) ?? byCand.set(d.candidate_id, []).get(d.candidate_id)!).push(d);
      joinedCerts = cs.reduce((n: number, c: any) => n + (byCand.get(c.id)?.length ?? 0), 0) + ss.length * 0 + ps.length * 0;
      split.push(Date.now() - t);
    }
    console.log(`  ...  option 1, four flat reads joined in memory (${joinedCerts} documents joined): ${split.join(' / ')} ms`);
    check(!pool.error && pool.rows.length === COUNT, `the signed-in read returns all ${COUNT} candidates across pages`, pool.error ?? `${pool.rows.length} rows · loads ${loads.join(' / ')} ms`);

    const bySeed = new Map(seeded.map((s) => [s.ref, s]));
    const QUERIES: { q: string; oracle: (s: Seeded) => boolean; needsCrm?: boolean }[] = [
      { q: 'welder AND norway', oracle: (s) => s.trade === 'Welder' && s.country === 'Norway', needsCrm: true },
      { q: '(painter OR blaster) AND (frosio OR ampp)', oracle: (s) => ['Painter', 'Blaster'].includes(s.trade) && s.certs.some((c) => /^(frosio|ampp)/.test(c)) },
      { q: '"placed at aibel"', oracle: (s) => s.placedAt === 'AIBEL', needsCrm: true },
      { q: 'contract AND "cswip 3.1" AND NOT "not available"', oracle: (s) => s.pref === 'contract' && s.certs.includes('cswip 3.1') && s.notes !== 'not available until spring', needsCrm: true },
      { q: 'orsted OR equinor', oracle: (s) => s.sentTo.some((c) => c === 'Ørsted' || c === 'Equinor') || s.placedAt === 'Ørsted' || s.placedAt === 'Equinor', needsCrm: true },
      { q: 'scaffolder AND NOT "offshore experience"', oracle: (s) => s.trade === 'Scaffolder' && s.notes !== 'offshore experience, own tools' },
    ];
    for (const { q, oracle, needsCrm } of QUERIES) {
      if (needsCrm && !crm) { console.log(`  ...  "${q}" skipped — needs 0035`); continue; }
      const want = new Set(seeded.filter(oracle).map((s) => s.ref));
      const times: number[] = [];
      let got: string[] = [];
      for (let r = 0; r < 15; r++) { const f = filterPool(pool.rows, { q }, { id: uid }); times.push(f.ms); got = f.rows.map((x) => x.reference ?? ''); }
      times.sort((a, b) => a - b);
      const same = got.length === want.size && got.every((ref) => want.has(ref) && bySeed.has(ref));
      check(same && want.size > 0, `"${q}" finds exactly the ${want.size} the independent filter finds`, `${got.length} found · search median ${times[7].toFixed(1)} ms · read ${loads[1]} ms`);
    }
    console.log(`  ...  at ${COUNT} candidates: the database read takes ${Math.min(...loads)}–${Math.max(...loads)} ms signed in; a search over the loaded pool takes under the times above`);
  } finally {
    const leftBehind = await removeProbe(admin, uid, workspace, null, { clearContent: true });
    if (leftBehind) { failures++; console.log(`\n  FAIL  cleanup — ${leftBehind}`); } else console.log('\nprobe user, its workspace and every seeded row removed');
  }
  console.log(failures === 0 ? 'candidate pool scale: all checks passed' : `candidate pool scale: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
