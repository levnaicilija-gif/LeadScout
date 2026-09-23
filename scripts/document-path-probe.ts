/**
 * Two different files with the same name both survive, as two distinct stored objects.
 *
 *   npx tsx --env-file=.env.local scripts/document-path-probe.ts http://localhost:3000
 *
 * The real failure, end to end. Until 2026-09-23 a stored object's key ended in
 * `digest(original file name)`, so two DIFFERENT files called the same thing resolved to one key and
 * the upload's `upsert: true` destroyed the first. Three real documents lost their files that way —
 * `17e7988c`, `add887a9` and `f87ca998` — and their rows are still on file with nothing behind them.
 *
 * Both uploads here stay UNATTACHED, which is where it bit: an unattached document has no candidate
 * id in its path, so the file name was the only thing separating two of them.
 *
 * The second file is the first with a trailing PDF comment appended — same name, same type, same
 * everything the old path could see, different bytes. Two document reads, about EUR 0.02, test spend.
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { markWorkspaceTest, followAllForProbe, removeProbe } from '../src/lib/test-data';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const stamp = Date.now();
const SAME_NAME = 'certificate.pdf';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

(async () => {
  const first = readFileSync('fixtures/test-certificate.pdf');
  // Different bytes, still a readable PDF: trailing content after %%EOF is ignored by readers.
  const second = Buffer.concat([first, Buffer.from(`\n% probe ${stamp}\n`)]);
  if (sha(first) === sha(second)) throw new Error('the two fixtures are identical — the probe would prove nothing');

  const email = `doc-path-probe+${stamp}@rfbt-recruitment.com`;
  const password = `probe-${stamp}-0123456789`;
  const { data: made, error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: 'Doc Path Probe', agency: 'Doc Path Probe' } });
  if (userError) throw new Error(`could not create the probe account: ${userError.message}`);
  const uid = made.user!.id;
  const { data: me } = await admin.from('users').select('workspace_id').eq('id', uid).maybeSingle();
  const workspace = me?.workspace_id as string;
  await markWorkspaceTest(admin, workspace);
  const followProblem = await followAllForProbe(admin, uid);
  if (followProblem) throw new Error(`the probe account could not follow all industries: ${followProblem}`);
  await admin.from('users').update({ role: 'senior', onboarding_day: 30 }).eq('id', uid);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type=email]', email);
    await page.fill('input[type=password]', password);
    await page.click('form button:not([type=button])');
    await page.waitForURL(/\/app\//, { timeout: 60000 });

    const drop = async (buffer: Buffer) => {
      const r = await page.request.post(`${BASE}/api/verify/intake`, {
        multipart: { files: { name: SAME_NAME, mimeType: 'application/pdf', buffer } },
        timeout: 180000,
      });
      return { status: r.status(), json: await r.json() };
    };

    const a = await drop(first);
    const b = await drop(second);
    check(a.status === 200 && b.status === 200, 'both uploads are accepted', `HTTP ${a.status} / ${b.status}`);

    // What actually landed, read from the database rather than from either response.
    const { data: docs, error } = await admin.from('documents')
      .select('id, storage_path, content_sha256, candidate_id, type')
      .eq('workspace_id', workspace).order('uploaded_at');
    if (error) throw new Error(`could not read the documents: ${error.message}`);
    const rows = docs ?? [];

    check(rows.length === 2, 'two documents are on file — neither upload replaced the other', `${rows.length} row(s)`);
    if (rows.length < 2) throw new Error('only one document was stored — nothing further can be asserted');

    const [p1, p2] = rows.map((d: any) => d.storage_path);
    check(p1 !== p2, 'THE FIX: two files with the SAME name get DIFFERENT keys', `${p1.split('/').pop()} vs ${p2.split('/').pop()}`);
    check(rows.every((d: any) => d.storage_path.endsWith(`${d.id}.pdf`)), 'each key ends in that document\'s own id',
      rows.map((d: any) => d.storage_path.split('/').pop()).join(', '));
    check(rows.every((d: any) => !d.candidate_id), 'both are unattached — the case where the name was the only separator');
    check(rows.every((d: any) => !/certificate\.pdf/i.test(d.storage_path)), 'and the file name is nowhere in either key');

    // The point of the whole exercise: both files still exist, and they are not the same file.
    const bytes: Buffer[] = [];
    for (const d of rows) {
      const { data: blob, error: dl } = await admin.storage.from('documents').download(d.storage_path);
      check(!dl && !!blob, `the object for ${d.id.slice(0, 8)} is really in storage`, dl?.message ?? `${d.storage_path.split('/').pop()}`);
      if (blob) bytes.push(Buffer.from(await blob.arrayBuffer()));
    }
    check(bytes.length === 2 && sha(bytes[0]) !== sha(bytes[1]),
      'AND THE TWO STORED OBJECTS HAVE DIFFERENT BYTES — neither was overwritten',
      bytes.length === 2 ? `${bytes[0].length} vs ${bytes[1].length} bytes` : `${bytes.length} readable`);
    check(bytes.some((x) => sha(x) === sha(first)) && bytes.some((x) => sha(x) === sha(second)),
      'and they are exactly the two files that were dropped');

    // 0044's hash should also tell them apart, independently of the path.
    const hashes = rows.map((d: any) => d.content_sha256).filter(Boolean);
    if (hashes.length === 2) check(hashes[0] !== hashes[1], 'their content hashes differ too, so the data layer agrees they are two files');
  } finally {
    await browser.close();
    const { data: cs } = await admin.from('candidates').select('id').eq('workspace_id', workspace);
    for (const c of cs ?? []) { await admin.from('documents').delete().eq('candidate_id', c.id); await admin.from('anonymized_cvs').delete().eq('candidate_id', c.id); }
    await admin.from('documents').delete().eq('workspace_id', workspace);
    await admin.from('candidates').delete().eq('workspace_id', workspace);
    const left = await removeProbe(admin, uid, workspace, null, { clearContent: true });
    if (left) { console.log(`\n  CLEANUP PROBLEM: ${left}`); failures++; }
    else console.log('\n  the probe account, its workspace and everything seeded were removed');
  }

  console.log(failures ? `\ndocument path probe: ${failures} FAILED` : '\ndocument path probe: all checks passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(`\ndocument path probe: ${e?.message ?? e}`); process.exitCode = 1; });
