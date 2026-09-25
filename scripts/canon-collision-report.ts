/**
 * Which company rows would `sameCompany` merge, and which names have lost their brand.
 *
 *   npx tsx --env-file=.env.local scripts/canon-collision-report.ts
 *
 * READ-ONLY: selects only, no writes of any kind, no model call, no browser. Safe to run at any time,
 * including beside a release gate.
 *
 * WHY IT EXISTS. `sameCompany` returns `{ same: true }` on its FIRST branch whenever two names are
 * equal once legal form, punctuation and accents are stripped — with no domain check on that branch.
 * On invented names that merges "Kraftwerk AG" with "Kraftwerk AS" and "TenneT TSO B.V." with
 * "TenneT TSO GmbH", where the legal form is the only thing separating a German entity from a
 * Norwegian or Dutch one, and `company-identity.ts` opens by saying a wrong merge moves another
 * company's leads and contacts onto the survivor with no way back. This answers whether the corpus
 * actually holds such a pair, rather than leaving it as a hypothesis about a live function.
 *
 * WHAT IT FOUND (2026-09-20, 5,860 company rows): five canonical collisions, and every one a TRUE
 * duplicate of the same company — ROSEN / ROSEN(UK) Limited, Siemens Gamesa Renewable Energy Co /
 * … & Co, SGL Gelter S.A. / SGL GELTER, S.A., TUV SUD / TÜV SÜD (the accent strip working as
 * designed), ForestWave Chartering B.V. / ForestWave Chartering. So the branch is **not a live
 * problem, which is not the same as the function being right**: it would still merge a real pair,
 * the data has simply never handed it one. Two things worth re-reading each time this runs:
 *   - those five pairs are duplicate rows `findOrCreateCompany` would now merge on sight;
 *   - ONE row already canonicalises to the bare word "services" (domain services.totalenergies.nl),
 *     the `canonCompany("SPA Group") → "group"` class, which needs no coincidence to collide — only
 *     a second company whose brand strips away.
 * `EMPTY CANON` was none across all 5,860, so the Ørsted / Cyrillic fix recorded in CLAUDE.md holds.
 *
 * The dangerous shape to watch for is a collision whose rows DISAGREE on domain or country: that is
 * two different companies being called one. A collision where both rows agree is a duplicate, which
 * is the benign case and the one this corpus currently holds.
 *
 * Related but different: `scripts/company-identity-check.ts` is the gate's rule check on
 * `sameCompany` itself. This reads the live table and reports what those rules would do to it.
 */
import { createClient } from '@supabase/supabase-js';
import { canonCompany, canonDomain, sameCompany } from '../src/lib/company-identity';

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

/** A word that on its own identifies nobody — a name reduced to one of these has lost its brand. */
const GENERIC = /^(group|holding|holdings|energi|energy|energie|marine|nord|sud|international|europe|nordic|service|services|solutions|industri|industries|bau|invest|projekt|project|as|gruppen)$/i;

async function main() {
  // Paged: companies passes 1,000 rows and one unpaged read stops there silently (CLAUDE.md, allRows).
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('companies')
      .select('id, name, domain, country, workspace_id, is_test').order('id').range(from, from + 999);
    if (error) throw new Error(`could not read companies: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const real = rows.filter((r) => !r.is_test);
  console.log(`companies on file: ${rows.length} (${real.length} not test)\n`);

  const byCanon = new Map<string, any[]>();
  const empty: any[] = [];
  const generic: any[] = [];
  for (const r of real) {
    const c = canonCompany(String(r.name ?? ''));
    if (!c) { empty.push(r); continue; }
    if (GENERIC.test(c)) generic.push({ ...r, canon: c });
    if (!byCanon.has(c)) byCanon.set(c, []);
    byCanon.get(c)!.push(r);
  }

  console.log('=== 1. COLLISIONS: different names on file, one canonical form ===');
  let found = 0, risky = 0;
  for (const [canon, group] of byCanon) {
    const names = [...new Set(group.map((g) => String(g.name).trim()))];
    if (names.length < 2) continue;
    found++;
    const domains = [...new Set(group.map((g) => canonDomain(g.domain)).filter(Boolean))];
    const countries = [...new Set(group.map((g) => g.country).filter(Boolean))];
    const verdict = sameCompany(
      { name: names[0], domain: group[0].domain },
      { name: names[1], domain: group[1]?.domain },
    );
    console.log(`\n  "${canon}"`);
    for (const g of group) console.log(`     ${String(g.name).slice(0, 52).padEnd(52)} domain=${canonDomain(g.domain) || '-'}  country=${g.country ?? '-'}`);
    console.log(`     distinct domains: ${domains.length ? domains.join(', ') : 'none'}   distinct countries: ${countries.join(', ') || 'none'}`);
    console.log(`     sameCompany says: ${verdict.same ? 'SAME' : 'not same'} — ${verdict.why}`);
    // Two different companies called one. A collision whose rows AGREE is only a duplicate.
    if (verdict.same && (domains.length > 1 || countries.length > 1)) {
      risky++;
      console.log(`     >> AT RISK: called one company while the rows disagree on ${domains.length > 1 ? 'domain' : 'country'}`);
    }
  }
  if (!found) console.log('  (none — no two company rows share a canonical form)');

  console.log('\n=== 2. BRAND LOSS: canonical form is a single generic word ===');
  if (!generic.length) console.log('  (none)');
  for (const g of generic) console.log(`  "${g.name}" -> "${g.canon}"  domain=${canonDomain(g.domain) || '-'}  country=${g.country ?? '-'}`);

  console.log('\n=== 3. EMPTY CANON: nothing left to compare ===');
  if (!empty.length) console.log('  (none)');
  for (const e of empty.slice(0, 20)) console.log(`  "${e.name}"`);

  console.log(`\nsummary: ${found} collision(s), ${risky} of them with rows that disagree, ${generic.length} brand-loss row(s), ${empty.length} unusable name(s).`);
  console.log('A collision whose rows agree is a duplicate to merge. One whose rows disagree is two companies about to become one.');
  console.log('Read-only: nothing was written.');
}

main().catch((e) => { console.error(e); process.exit(1); });
