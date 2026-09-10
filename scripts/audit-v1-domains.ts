/**
 * Why the v1 domain list rejected so many rows. Pure HTTP, no model calls: fetch each of the
 * 119 domains and sort the failures by what actually happened, so "mostly dead" is a checked
 * statement rather than an assumption.
 *
 *   npx tsx --env-file=.env.local scripts/audit-v1-domains.ts
 */
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';
import { httpGet } from '../src/lib/http';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const rows = parse(fs.readFileSync(path.join(process.cwd(), 'seeds', 'company_domains_from_v1.csv')), { columns: true, skip_empty_lines: true }) as any[];
const clean = (d: string) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

async function pool<T>(items: T[], size: number, fn: (t: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(size, q.length) }, async () => {
    for (let it = q.shift(); it; it = q.shift()) await fn(it);
  }));
}

(async () => {
  const { data: have } = await db.from('companies').select('domain, name, source').not('domain', 'is', null);
  const landed = new Map((have ?? []).map((c: any) => [String(c.domain).toLowerCase(), c]));

  const buckets: Record<string, string[]> = {};
  const put = (k: string, d: string) => (buckets[k] ??= []).push(d);

  await pool(rows.map((r) => clean(String(r.domain ?? ''))).filter(Boolean), 10, async (d) => {
    if (landed.has(d)) { put('in the database', d); return; }
    const res = await httpGet(`https://${d}`, {}, 15000);
    if (!res.ok) { put(res.status ? `HTTP ${res.status}` : `did not connect (${(res.error ?? '').slice(0, 40)})`, d); return; }
    const body = res.body.toLowerCase();
    if (/domain (is )?(for sale|parked)|buy this domain|domainnameshop|sedoparking|this domain has expired|godaddy.*parked/.test(body)) { put('parked or for sale', d); return; }
    if (body.length < 1500) put('loads but has almost no content', d);
    else put('loads fine — rejected by the classifier as not an employer of trades', d);
  });

  console.log(`${rows.length} domains in the v1 list\n`);
  Object.entries(buckets).sort((a, b) => b[1].length - a[1].length).forEach(([k, v]) => {
    console.log(`${String(v.length).padStart(3)}  ${k}`);
    console.log(`     ${v.slice(0, 8).join(', ')}${v.length > 8 ? ` … +${v.length - 8}` : ''}`);
  });
})();
