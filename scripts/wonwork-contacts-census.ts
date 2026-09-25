/**
 * Item 21, read only: where Won work's contacts stand before any discovery runs.
 *
 *   npx tsx --env-file=.env.local scripts/wonwork-contacts-census.ts [--save .cache/wonwork-contacts-before.json]
 *
 * Every open won-work lead (not is_test) in the real workspace, put in one of three sets: a tender award; a news lead
 * with a quoted person (a contact on the lead); a news lead with none. For each: whether its company has a domain,
 * has been checked by the contact pass (contacts_checked_at), holds a switchboard or general email, or holds people on
 * the company itself (contacts with lead_id null); and whether the quoted person already has an email or phone.
 * Also: how many companies the leads share, and how many are Hiring now companies the pass already covers.
 * --save writes the per-lead state, so the after-run can say exactly which leads gained a contact.
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { leadSource } from '../src/lib/lead-source';
import { CLOSED_LEAD_STATUSES, LEAD_STATE_EMBED, LEAD_STATE_TABLE } from '../src/lib/workspace-state';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const saveAt = process.argv.includes('--save') ? process.argv[process.argv.indexOf('--save') + 1] : null;

(async () => {
  const { data: ws } = await db.from('workspaces').select('id').eq('name', 'RFBT Recruitment').single();
  const { data: leads, error } = await db.from('leads')
    .select(`id, company_id, source_url, project_name, companies(id, name, domain, contacts_checked_at, switchboard, general_email, contact_page_url), ${LEAD_STATE_EMBED}`)
    .eq('workspace_id', ws!.id).eq('kind', 'won_work').eq('is_test', false).not(`${LEAD_STATE_TABLE}.status`, 'in', CLOSED_LEAD_STATUSES).limit(5000);
  if (error) throw new Error(error.message);
  const ids = (leads ?? []).map((l) => l.id);
  const coIds = [...new Set((leads ?? []).map((l) => l.company_id).filter(Boolean))] as string[];
  const leadContacts: any[] = [];
  for (let i = 0; i < ids.length; i += 100) leadContacts.push(...((await db.from('contacts').select('id, lead_id, name, email, phone').in('lead_id', ids.slice(i, i + 100))).data ?? []));
  const coContacts: any[] = [];
  for (let i = 0; i < coIds.length; i += 100) coContacts.push(...((await db.from('contacts').select('id, company_id, name, email, phone').is('lead_id', null).in('company_id', coIds.slice(i, i + 100))).data ?? []));
  const { data: open } = await db.from('job_posts').select('company_id').eq('status', 'open').not('company_id', 'is', null).limit(5000);
  const hiringCos = new Set((open ?? []).map((p) => p.company_id));

  const rows = (leads ?? []).map((l: any) => {
    const quoted = leadContacts.filter((c) => c.lead_id === l.id);
    const people = coContacts.filter((c) => c.company_id === l.company_id);
    const co = l.companies ?? {};
    const set = leadSource(l.source_url) === 'tender' ? 'tender' : quoted.length ? 'news_quoted' : 'news_none';
    return {
      id: l.id, company_id: l.company_id, company: co.name ?? '?', set,
      domain: !!co.domain, checked: !!co.contacts_checked_at, switchboard: !!co.switchboard, general: !!co.general_email,
      companyPeople: people.length, quoted: quoted.length, quotedReachable: quoted.filter((c) => c.email || c.phone).length,
      hiringNow: hiringCos.has(l.company_id),
      // Named: a person with an email or phone — the quoted person or someone off the company's own site. Generic: only the
      // company's switchboard or general email. Reported apart, because a switchboard is not a decision-maker.
      namedReachable: quoted.filter((c) => c.email || c.phone).length + people.filter((c) => c.email || c.phone).length,
      genericOnly: !quoted.some((c) => c.email || c.phone) && !people.some((c) => c.email || c.phone) && (!!co.switchboard || !!co.general_email),
      // "A contact": a named person with an email or phone, or the company's switchboard or general email.
      hasContact: quoted.some((c) => c.email || c.phone) || people.some((c) => c.email || c.phone) || !!co.switchboard || !!co.general_email,
    };
  });
  const by = (s: string) => rows.filter((r) => r.set === s);
  for (const s of ['tender', 'news_quoted', 'news_none']) {
    const r = by(s);
    const cos = new Set(r.map((x) => x.company_id));
    console.log(`${s}: ${r.length} leads · ${cos.size} companies · with a contact now ${r.filter((x) => x.hasContact).length} · company has a domain ${r.filter((x) => x.domain).length} · already checked ${r.filter((x) => x.checked).length} · switchboard ${r.filter((x) => x.switchboard).length} · general email ${r.filter((x) => x.general).length} · company people ${r.filter((x) => x.companyPeople).length}${s === 'news_quoted' ? ` · quoted person already reachable ${r.filter((x) => x.quotedReachable).length}` : ''} · Hiring now company ${r.filter((x) => x.hiringNow).length}`);
  }
  const perCo = new Map<string, number>();
  for (const r of rows) perCo.set(r.company_id, (perCo.get(r.company_id) ?? 0) + 1);
  const shared = [...perCo.values()].filter((n) => n > 1);
  console.log(`total ${rows.length} leads · ${perCo.size} companies · companies behind more than one lead ${shared.length} (${shared.reduce((a, b) => a + b, 0)} leads) · companies without a domain ${new Set(rows.filter((r) => !r.domain).map((r) => r.company_id)).size}`);
  const mixed = [...perCo.keys()].filter((c) => new Set(rows.filter((r) => r.company_id === c).map((r) => r.set)).size > 1);
  console.log(`companies with leads in more than one set: ${mixed.length}${mixed.length ? ` — ${mixed.slice(0, 6).map((c) => rows.find((r) => r.company_id === c)!.company).join(', ')}` : ''}`);
  if (saveAt) { writeFileSync(saveAt, JSON.stringify(rows, null, 1)); console.log(`saved ${rows.length} rows to ${saveAt}`); }
})().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
