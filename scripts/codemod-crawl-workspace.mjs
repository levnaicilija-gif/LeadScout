// One-off: replace the unordered "first workspace" pick in the job routes with crawlWorkspace(db). Prints what changed.
import { readFileSync, writeFileSync } from 'fs';

const files = [
  'src/app/api/jobs/directories/route.ts', 'src/app/api/jobs/companies/route.ts', 'src/app/api/jobs/seed-domains/route.ts',
  'src/app/api/jobs/classify-sources/route.ts', 'src/app/api/jobs/classify-employers/route.ts', 'src/app/api/jobs/job-boards/route.ts',
  'src/app/api/jobs/resolve-domains/route.ts', 'src/app/api/jobs/classify/route.ts', 'src/app/api/jobs/registries/route.ts',
  'src/lib/jobs/job-posts-batch.ts',
];
const PICK = /const \{ data: ws \} = await db\.from\('workspaces'\)\.select\('id'\)\.limit\(1\)\.maybeSingle\(\);(\r?\n)(\s*)if \(!ws\) return NextResponse\.json\(\{ error: 'no workspace' \}, \{ status: 400 \}\);/;
let bad = 0;
for (const f of files) {
  let s = readFileSync(f, 'utf8');
  const m = s.match(PICK);
  if (!m) { console.log(`NO MATCH ${f}`); bad++; continue; }
  const [nl, ind] = [m[1], m[2]];
  s = s.replace(PICK,
    `// Named, never "the first workspace": with two workspaces an unordered limit(1) could file this job's work under either.${nl}` +
    `${ind}const ws = await crawlWorkspace(db).then((id) => ({ id, error: '' }), (e: Error) => ({ id: '', error: e.message }));${nl}` +
    `${ind}if (!ws.id) return NextResponse.json({ error: ws.error }, { status: 500 });`);
  // Import beside the supabase server import.
  const imp = /(import \{[^}]*\} from '@\/lib\/supabase\/server';)(\r?\n)/;
  if (!imp.test(s)) { console.log(`NO IMPORT ANCHOR ${f}`); bad++; continue; }
  s = s.replace(imp, `$1$2import { crawlWorkspace } from '@/lib/crawl-workspace';$2`);
  writeFileSync(f, s);
  console.log(`changed ${f}`);
}
process.exitCode = bad ? 1 : 0;
