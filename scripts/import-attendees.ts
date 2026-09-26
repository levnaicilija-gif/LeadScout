/**
 * Import an event attendee list into people without duplicating anyone already on file.
 *
 *   npx tsx --env-file=.env.local scripts/import-attendees.ts <url-or-saved-html> --event "WindEurope Annual Event 2026" [--write]
 *
 * Without --write it reads, parses and plans, and prints the totals, ten sample rows and title changes; nothing is
 * written. WindEurope's attendee page is one table in one response (11,031 rows on 2026-09-14; the filter and sort
 * on the page are client-side), and the row count is checked against the table's <tr> count so a truncated
 * download fails instead of importing part of the list.
 *
 * Names, companies, titles and countries only. The site hides a few e-mail addresses behind Cloudflare in the title
 * column; that title is stored as unknown and the address is never decoded — people holds no e-mail or phone.
 * The plan is src/lib/attendee-import.ts; --write needs 0030 (seen_at_events, title_history).
 */
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import { planImport, type IncomingAttendee } from '../src/lib/attendee-import';
import { probeAdmin } from '../src/lib/test-data';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--event');
const event = args[args.indexOf('--event') + 1];
const write = args.includes('--write');
if (!target || !event || args.indexOf('--event') < 0) { console.error('usage: import-attendees.ts <url-or-file> --event "<list name>" [--write]'); process.exit(1); }

const decode = (s: string) => s.replace(/<[^>]+>/g, '')
  .replace(/&#160;|&nbsp;/g, ' ').replace(/&amp;|&#0?38;/g, '&').replace(/&quot;|&#0?34;/g, '"').replace(/&#0?39;|&#8217;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const cell = (row: string, cls: string) => (row.split(`<td class="${cls}">`)[1] ?? '').split('</td>')[0];

function parse(html: string) {
  const start = html.indexOf('<table class="event-attendees"');
  const end = html.indexOf('</table>', start);
  if (start < 0 || end < 0) throw new Error('no <table class="event-attendees"> on the page');
  const table = html.slice(start, end);
  const trCount = table.split('<tr').length - 1;
  const rows = table.split('<tr').slice(1).map((r) => r.split('</tr>')[0]).filter((r) => r.includes('<td'));
  let hiddenEmails = 0;
  const people: IncomingAttendee[] = rows.map((r) => {
    const rawTitle = cell(r, 'job-title');
    const hidden = rawTitle.includes('__cf_email__') || rawTitle.includes('email-protection');
    if (hidden) hiddenEmails++;
    const country = decode(cell(r, 'country'));
    return {
      company_name: decode(cell(r, 'organization')),
      name: decode(cell(r, 'name')),
      title: hidden ? null : decode(rawTitle) || null,
      country: country && !/^unknown/i.test(country) ? country : null,
    };
  });
  return { people, trCount, headerRows: trCount - rows.length, hiddenEmails };
}

(async () => {
  const html = /^https?:\/\//.test(target)
    ? await fetch(target, { headers: { 'user-agent': 'Mozilla/5.0 LeadScout attendee import' } }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
    : fs.readFileSync(target, 'utf8');
  const { people, trCount, headerRows, hiddenEmails } = parse(html);
  if (people.length + headerRows !== trCount || headerRows !== 1) throw new Error(`row count does not add up: ${trCount} <tr>, ${people.length} data rows, ${headerRows} header rows`);
  console.log(`list "${event}": ${people.length} attendee rows (${trCount} <tr> in the table, 1 header) · ${hiddenEmails} titles hidden behind an e-mail link, stored as unknown · ${html.length} bytes`);
  console.log('taken to be newer than the lists already on file: a different title replaces the stored one, which is kept in title_history');

  const db = probeAdmin();
  const { data: ws, error: wsErr } = await db.from('workspaces').select('id').eq('name', 'RFBT Recruitment').single();
  if (wsErr || !ws) throw new Error(`the real workspace was not found: ${wsErr?.message}`);
  const probe = await db.from('people').select('seen_at_events, title_history').limit(1);
  const has0030 = !probe.error;
  if (write && !has0030) throw new Error(`--write needs migration 0030 (people.seen_at_events, title_history): ${probe.error?.message}`);

  const existing: any[] = [];
  const cols = `id, name, company_name, title, country, source, ops_relevant${has0030 ? ', seen_at_events, title_history' : ''}`;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('people').select(cols).eq('workspace_id', ws.id).order('id').range(from, from + 999);
    if (error) throw new Error(`people could not be read: ${error.message}`);
    if (!data?.length) break;
    existing.push(...data);
    if (data.length < 1000) break;
  }
  const now = new Date().toISOString();
  const plan = planImport(existing, people, event, now);
  console.log(`people on file: ${existing.length} (${plan.existingDuplicates} already duplicated by name+company before this import)`);
  console.log(`plan: ${plan.updates.length} already on file (seen again; ${plan.titleChanges.length} with a different title) · ${plan.inserts.length} new · ${plan.repeatedInList} repeated inside the list · ${plan.unusable} without a name or company · ${plan.alreadyRecorded} already imported from this list`);

  const usable = people.filter((p) => p.name && p.company_name);
  console.log('\nten parsed rows, evenly spaced through the list:');
  for (let n = 0; n < 10; n++) console.log(`  ${n + 1}. ${JSON.stringify(usable[Math.floor((n + 0.5) * usable.length / 10)])}`);
  console.log('\nfive title changes:');
  plan.titleChanges.slice(0, 5).forEach((t) => console.log(`  ${t.name} @ ${t.company}: "${t.from}" → "${t.to}"`));

  if (!write) { console.log('\ndry run — nothing written. Add --write to import.'); return; }

  const before = (await db.from('people').select('id', { count: 'exact', head: true }).eq('workspace_id', ws.id)).count ?? 0;
  for (let i = 0; i < plan.inserts.length; i += 500) {
    const { error } = await db.from('people').insert(plan.inserts.slice(i, i + 500).map((p) => ({ ...p, workspace_id: ws.id })));
    if (error) throw new Error(`insert failed at row ${i}: ${error.message} — rerun: rows already written are recognised and skipped`);
  }
  let updated = 0;
  const queue = [...plan.updates];
  const failures: string[] = [];
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      const { id, ...fields } = u;
      let error: any = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        ({ error } = await db.from('people').update(fields).eq('id', id).eq('workspace_id', ws.id));
        if (!error) break;
        await new Promise((ok) => setTimeout(ok, 2000 * attempt));
      }
      if (error) failures.push(`${id}: ${error.message}`); else updated++;
    }
  }));
  const after = (await db.from('people').select('id', { count: 'exact', head: true }).eq('workspace_id', ws.id)).count ?? 0;
  const tagged = (await db.from('people').select('id', { count: 'exact', head: true }).eq('workspace_id', ws.id).contains('seen_at_events', [event])).count ?? 0;
  console.log(`\nwritten: ${plan.inserts.length} inserted (people ${before} → ${after}) · ${updated} of ${plan.updates.length} updated · people now tagged with "${event}": ${tagged}`);
  if (failures.length) { console.log(`update failures (${failures.length}) — rerun to finish:\n  ${failures.slice(0, 5).join('\n  ')}`); process.exit(1); }
  if (after - before !== plan.inserts.length) { console.log('FAIL: the people count did not grow by the number inserted'); process.exit(1); }
})().catch((e) => { console.error(e.message ?? e); process.exit(1); });
