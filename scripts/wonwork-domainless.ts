/** Item 21, read only: the won-work companies with no domain on file — countries, a name sample, and what resolve-domains has already tried. */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { probeAdmin } from '../src/lib/test-data';

const db = probeAdmin();
(async () => {
  const rows: any[] = JSON.parse(readFileSync('.cache/wonwork-contacts-before.json', 'utf8'));
  const ids = [...new Set(rows.filter((r) => !r.domain).map((r) => r.company_id))];
  const { data: cos, error } = await db.from('companies').select('id, name, country, careers_status, registry, registry_id, source').in('id', ids);
  if (error) throw new Error(error.message);
  const byCountry: Record<string, number> = {};
  for (const c of cos ?? []) byCountry[c.country ?? '—'] = (byCountry[c.country ?? '—'] ?? 0) + 1;
  console.log(`won-work companies without a domain: ${ids.length}`);
  console.log(`by country: ${Object.entries(byCountry).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const byStatus: Record<string, number> = {};
  for (const c of cos ?? []) byStatus[c.careers_status ?? 'never looked at'] = (byStatus[c.careers_status ?? 'never looked at'] ?? 0) + 1;
  console.log(`careers_status (what domain/careers discovery recorded): ${JSON.stringify(byStatus)}`);
  console.log(`registry id on file: ${(cos ?? []).filter((c) => c.registry_id).length} · source: ${JSON.stringify(Object.fromEntries(Object.entries((cos ?? []).reduce((m: any, c) => { m[c.source ?? '—'] = (m[c.source ?? '—'] ?? 0) + 1; return m; }, {}))))}`);
  console.log(`sample: ${(cos ?? []).slice(0, 15).map((c) => `${c.name} (${c.country ?? '—'})`).join(' · ')}`);
  const { data: withDomain } = await db.from('companies').select('name, domain, country').in('id', [...new Set(rows.filter((r) => r.domain).map((r) => r.company_id))]).limit(40);
  console.log(`\nwith a domain (${(withDomain ?? []).length}): ${(withDomain ?? []).map((c) => `${c.name}=${c.domain}`).join(' · ')}`);
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
