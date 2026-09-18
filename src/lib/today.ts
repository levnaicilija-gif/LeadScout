import type { SupabaseClient } from '@supabase/supabase-js';
import type { IndustryId } from '@/lib/industry';
import { hasIndustries } from '@/lib/schema-features';
import { hasPostingContact, hasHiringState, hasAwardDate } from './schema-features';
import { newsLeadAge, tenderLeadAge, postingAge, reAdverts, roleKey, ageSink, REPOST_WINDOW_DAYS } from './lead-age';
import { leadSource, primaryArticle } from './lead-source';
import { articlesByLead } from './lead-articles';
import { compoundByCompany } from './compound-signals-load';
import { boostedFit, boostedPressure, type Pressure } from './compound-signals';

/**
 * The day, in order. Six queries in a fixed priority — no model chooses any of this.
 *
 * Home and Today both render it, so it lives here rather than in either page: a home screen
 * that says "7 to do" while Today lists five is worse than no count at all.
 */
export type TodayItem = {
  dot: '' | 'warn' | 'bad';
  title: string;
  sub: string;
  href: string;
  why: string;
  from: string;
  /** HH:MM, and only when something is genuinely booked for that time. Otherwise there is no clock. */
  at?: string;
  /**
   * WHEN the thing behind this item happened, as an ISO timestamp — so Today can split its queue
   * into "while you were out" and "since you arrived" (2026-09-17).
   *
   * Deliberately absent on items that have no event time. An expiring certificate is a date in the
   * future, not something that happened; a campaign short of documents is a standing state. Those
   * belong in neither window, and visit.ts drops an item with no `when` from both rather than
   * guessing one — inventing a timestamp would put a standing task in "while you were out" every
   * single morning.
   */
  when?: string | null;
};

const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

export async function todayItems(sb: SupabaseClient, followed: IndustryId[] | 'all' = 'all'): Promise<TodayItem[]> {
  // Item 18: what the reader follows comes first — a lead or company in those industries, then the rest. Nothing is dropped.
  const industriesOn = await hasIndustries(sb);
  const followedFirst = (industries: string[] | null | undefined) => (followed !== 'all' && (industries ?? []).some((i) => (followed as string[]).includes(i)) ? 0 : 1);
  // 0024 gives an award notice its own award date; before it, an award lead ages from the notice's publication.
  const awardCols = (await hasAwardDate(sb)) ? ', award_date, award_date_basis' : '';
  const [pending, noReply, newLeads, expiring, missingDocs, hiring] = await Promise.all([
    sb.from('verifications').select('id, issuer_email_sent_at, documents(candidate_id, extracted, candidates!candidate_id(reference_code))').eq('result', 'pending'),
    sb.from('outreach').select('id, sent_at, leads(project_name, companies(name))').eq('status', 'sent').is('reply_at', null).lte('sent_at', day(-3)),
    sb.from('leads').select(`id, kind, company_id, country, project_name, fit_score, trades_inferred, source_url, created_at, companies(name)${industriesOn ? ', industries' : ''}`).eq('status', 'new').gte('created_at', day(-7)).order('fit_score', { ascending: false }).limit(20),
    sb.from('verifications').select('id, valid_until, documents(cert_body, candidates!candidate_id(id, reference_code))').eq('result', 'valid').lte('valid_until', day(60).slice(0, 10)),
    campaignsMissingDocs(sb),
    hiringWorthCalling(sb, industriesOn, followedFirst),
  ]);

  const items: TodayItem[] = [];

  // 4 · New leads, by fit then timing. Read before anything is chased.
  //
  // Won work and hiring now are one item, because they are one job: read what came in and
  // decide who to call. Each company is labelled with which it is, so a recruiter can see at a
  // glance whether the reason to call is a contract award or an open advert.
  // Item 17: the six shown are chosen fresh-first, and an ageing or stale signal says so. Nothing is
  // dropped for its age alone; age unknown counts as fresh.
  // Articles are read with the service role for these leads only — no read policy until 0025. If that
  // read fails, the leads still show, each "age unknown", rather than the item vanishing.
  const { byLead } = await articlesByLead(((newLeads.data ?? []) as any[]).map((l) => l.id), awardCols);
  for (const l of (newLeads.data ?? []) as any[]) l.lead_articles = byLead.get(l.id) ?? [];
  // Item 19: a lead whose company has two or more signal types inside 60 days ranks by its boosted fit and says
  // "boosted"; Leads and its drawer give the reason. If the signals cannot be read, the stored fit ranks it, as before.
  const { byCompany: leadSignals } = await compoundByCompany(sb, ((newLeads.data ?? []) as any[]).map((l) => l.company_id), awardCols);
  const aged = ((newLeads.data ?? []) as any[]).map((l) => {
    const a: any = primaryArticle(l.lead_articles, l.source_url);
    const age = leadSource(l.source_url) === 'tender'
      ? tenderLeadAge({ awardDate: a?.award_date, awardBasis: a?.award_date_basis, publishedAt: a?.published_at, awardDateRead: !!awardCols })
      : newsLeadAge({ publishedAt: a?.published_at });
    const signals = leadSignals.get(l.company_id);
    const lifted = signals && signals.factor > 1 ? boostedFit(l.fit_score ?? 0, signals, l.country) : null;
    return { l, age, fit: lifted?.fit ?? l.fit_score ?? 0, boosted: !!lifted };
  }).sort((x, y) => (followedFirst(x.l.industries) - followedFirst(y.l.industries)) || (ageSink(x.age.state) - ageSink(y.age.state)) || (y.fit - x.fit)).slice(0, 6);
  const leadNames = aged
    .map(({ l, age, boosted }) => {
      const notes = [age.state === 'stale' ? 'stale signal' : age.state === 'flagged' ? 'ageing' : '', boosted ? 'boosted' : ''].filter(Boolean);
      return l.companies?.name && `${l.companies.name}${notes.length ? ` (${notes.join(', ')})` : ''}`;
    })
    .filter(Boolean) as string[];
  const hiringNames = hiring.map((h) => `${h.name} (hiring now${h.ageing ? ', ageing' : ''})`);
  const allNames = [...leadNames, ...hiringNames];
  if (allNames.length) {
    const n = aged.length + hiring.length;
    // The newest thing in this one combined item is its timestamp: it is the moment that makes the
    // item worth reading now, and the only honest stamp for a row that stands for several leads.
    const newest = [...aged.map(({ l }) => l.created_at), ...hiring.map((h) => h.newest)]
      .filter(Boolean).map(String).sort().pop() ?? null;
    // The item names these companies, so its link must show THESE and nothing else (2026-09-17). It used
    // to open the whole unfiltered list — 165 leads — which turned a named eleven into a suggestion to go
    // looking rather than somewhere to arrive. The two halves are different tables on different tabs: six
    // won-work leads by lead id, five hiring-now companies by company id. Each tab carries its own `ids`
    // and `also` names the other set, which is what lets the filtered view offer "+5 hiring now" without
    // recomputing a ranking that would have moved on by the time the recruiter clicked.
    const leadIds = aged.map(({ l }) => String(l.id)).filter(Boolean);
    const companyIds = hiring.map((h) => String(h.id)).filter(Boolean);
    items.push({
      dot: '',
      when: newest,
      title: `Read ${n} new lead${n === 1 ? '' : 's'}${allNames[0] ? ` — ${allNames[0]} first` : ''}`,
      sub: allNames.join(', '),
      href: leadIds.length
        ? `/app/radar?tab=won&ids=${leadIds.join(',')}${companyIds.length ? `&also=${companyIds.join(',')}` : ''}`
        : companyIds.length ? `/app/radar?tab=hiring&ids=${companyIds.join(',')}` : '/app/radar',
      why: hiring.length
        ? 'Contract awards are demand months before a job is posted; an open advert is demand today.'
        : 'Contract awards are demand months before a job is posted.',
      from: hiring.length
        ? 'leads with status = new in the last 7 days (fresh signals first, then fit — boosted where the company has an award, a story or an open advert together inside 60 days), plus hiring-now companies under high pressure (an award or a story beside the adverts lifts pressure one step), naming a contact or re-advertising a role'
        : 'leads with status = new in the last 7 days, fresh signals first, then by fit — boosted where the company has an award, a story or an open advert together inside 60 days',
    });
  }

  // 2 · Verifications blocking a pack.
  for (const v of pending.data ?? []) {
    const doc: any = v.documents;
    const sent = v.issuer_email_sent_at ? new Date(v.issuer_email_sent_at).getTime() : Date.now();
    items.push({
      dot: 'warn',
      // When the issuer was asked. A reply that has not come is dated by the asking.
      when: v.issuer_email_sent_at ?? null,
      title: `Issuer reply due on ${doc?.candidates?.reference_code ?? 'a candidate'}'s ${doc?.extracted?.issuer ?? 'certificate'} — day ${Math.max(1, Math.ceil((Date.now() - sent) / 86400000))}`,
      sub: 'Nudge drafted · blocks one pack',
      href: `/app/candidates?ref=${doc?.candidates?.reference_code ?? ''}`,
      why: 'A pending certificate blocks the candidate\'s pack.',
      from: 'verifications where result = pending',
    });
  }

  // 3 · Outreach with no reply after 3 / 7 days.
  for (const o of noReply.data ?? []) {
    const l: any = o.leads;
    items.push({
      dot: '',
      when: o.sent_at ?? null,
      title: `Follow up ${l?.companies?.name ?? 'a contact'} — no reply since ${new Date(o.sent_at).toLocaleDateString('en-GB')}`,
      sub: l?.project_name ?? '',
      href: '/app/radar',
      why: 'Most replies come on the 2nd or 3rd touch.',
      from: 'outreach sent ≥ 3 days ago with no reply',
    });
  }

  // 5 · Certificates expiring within 60 days — and the ones that have already gone.
  const today = new Date().toISOString().slice(0, 10);
  for (const v of expiring.data ?? []) {
    const doc: any = v.documents;
    const gone = !!v.valid_until && v.valid_until < today;
    const days = v.valid_until ? Math.round((Date.parse(v.valid_until) - Date.now()) / 86400000) : null;
    items.push({
      dot: gone ? 'bad' : 'warn',
      title: gone
        ? `${doc?.candidates?.reference_code ?? 'A candidate'} · ${doc?.cert_body?.toUpperCase() ?? 'certificate'} EXPIRED ${v.valid_until}`
        : `${doc?.candidates?.reference_code ?? 'A candidate'} · ${doc?.cert_body?.toUpperCase() ?? 'certificate'} expires ${v.valid_until}${days !== null ? ` — ${days} day${days === 1 ? '' : 's'}` : ''}`,
      sub: gone ? 'Cannot be sent to a client until it is renewed' : 'Renewal message drafted',
      // Item 24: the candidate's own page, where the certificate, its expiry and a replacement drop zone are.
      href: doc?.candidates?.id ? `/app/candidates/${doc.candidates.id}` : `/app/candidates?ref=${doc?.candidates?.reference_code ?? ''}`,
      why: 'An expired certificate found on site means a sent-home worker, and a client who stops calling.',
      from: 'verifications valid_until ≤ 60 days',
    });
  }

  // 6 · Campaign candidates missing documents. Last in the list and first in urgency when the
  // campaign is close: a person cannot travel without their passport, medical and A1.
  for (const row of missingDocs) {
    const startsIn = row.starts_on ? Math.ceil((Date.parse(row.starts_on) - Date.now()) / 86400000) : null;
    const soon = startsIn !== null && startsIn <= 21;
    items.push({
      dot: soon ? 'bad' : 'warn',
      title: `${row.campaign}: ${row.people} candidate${row.people === 1 ? '' : 's'} missing ${row.docs.join(', ')}`,
      sub: startsIn === null
        ? 'No start date on the campaign'
        : startsIn < 0 ? `Started ${-startsIn} day${startsIn === -1 ? '' : 's'} ago`
          : `Starts in ${startsIn} day${startsIn === 1 ? '' : 's'}${row.company ? ` · ${row.company}` : ''}`,
      href: `/app/campaigns?id=${row.id}`,
      why: 'A campaign that starts with documents outstanding is a person who cannot travel.',
      from: 'campaign candidates whose required documents are not on file',
    });
  }

  // Nearest deadline first inside the list, then the fixed query order decides.
  return items;
}

/** One row per campaign that has anybody short of a required document. */
export type MissingDocsRow = { id: string; campaign: string; company?: string | null; starts_on: string | null; people: number; docs: string[] };

export async function campaignsMissingDocs(sb: SupabaseClient): Promise<MissingDocsRow[]> {
  const { data: campaigns, error } = await sb
    .from('campaigns')
    .select('id, name, starts_on, required_docs, companies(name), campaign_candidates(candidate_id, candidates(id, reference_code))')
    .eq('status', 'active');
  // The table predates its UI; if anything about it is not ready, Today still renders.
  if (error || !campaigns?.length) return [];

  const rows: MissingDocsRow[] = [];
  for (const c of campaigns as any[]) {
    const ids = (c.campaign_candidates ?? []).map((cc: any) => cc.candidate_id).filter(Boolean);
    const required: string[] = c.required_docs ?? [];
    if (!ids.length || !required.length) continue;

    const { data: docs } = await sb.from('documents').select('candidate_id, type').in('candidate_id', ids);
    const held = new Map<string, Set<string>>();
    for (const d of docs ?? []) {
      const set = held.get(d.candidate_id) ?? new Set<string>();
      set.add(d.type);
      held.set(d.candidate_id, set);
    }

    const shortOf = new Set<string>();
    let people = 0;
    for (const id of ids) {
      const has = held.get(id) ?? new Set<string>();
      const missing = required.filter((r) => !has.has(r));
      if (!missing.length) continue;
      people++;
      missing.forEach((m) => shortOf.add(m));
    }
    if (people) rows.push({ id: c.id, campaign: c.name, company: c.companies?.name ?? null, starts_on: c.starts_on ?? null, people, docs: [...shortOf] });
  }
  return rows.sort((a, b) => (a.starts_on ?? '9999').localeCompare(b.starts_on ?? '9999'));
}

/** The six queries, in the order they run — shown to the recruiter as "How this list is made". */
export const HOW_THIS_LIST_IS_MADE = [
  'Scheduled calls and flights this week',
  'Verifications blocking a pack',
  'Outreach with no reply after 3 / 7 days',
  'New leads, by fit then timing',
  'Certificates expiring within 60 days',
  'Campaign candidates missing documents',
];

/**
 * The label in front of an item. A clock time appears only where a call is actually booked;
 * everything else is "Now" for the next thing and "Today" for the rest, because inventing
 * 11:00 for work that has no appointment is a small lie the recruiter would plan around.
 */
export const whenLabel = (item: TodayItem, index: number) => item.at ?? (index === 0 ? 'Now' : 'Today');


/**
 * Hiring-now companies worth a call today.
 *
 * Three reasons qualify and no others. High pressure means the volume and the recency both say
 * they are short of people now. A contact printed on the advert means there is a named person
 * to ring, which is the difference between a task and a browse. A role re-advertised on three or
 * more days inside 180 (item 17) is a job that keeps not filling, and goes first. A company
 * whose newest advert is ageing goes last and says so. A company already marked "not for us"
 * never comes back.
 *
 * Guarded: the contact column and the row state both arrive with 0020, and naming a column that
 * does not exist fails the whole query rather than omitting a field.
 */
async function hiringWorthCalling(sb: SupabaseClient, industriesOn = false, followedFirst: (i: string[] | null | undefined) => number = () => 1): Promise<{ id: string; name: string; why: string; ageing: boolean; newest: string | null }[]> {
  const contacts = await hasPostingContact(sb);
  const state = await hasHiringState(sb);
  const cols = `company_id, role, title, headcount, posted_at, first_seen_at${contacts ? ', contact_name' : ''}, companies!inner(name${state ? ', hiring_status' : ''}${industriesOn ? ', industries' : ''})`;
  const { data, error } = await sb.from('job_posts').select(cols as '*')
    .eq('status', 'open').not('company_id', 'is', null).limit(400) as { data: any[] | null; error: any };
  if (error || !data) return [];

  const byCompany = new Map<string, any[]>();
  for (const p of data) {
    if (state && p.companies?.hiring_status === 'not_for_us') continue;
    const k = p.company_id as string;
    (byCompany.get(k) ?? byCompany.set(k, []).get(k)!).push(p);
  }

  // Item 19: each company's signals inside 60 days. A company with an award or a story beside its adverts is one pressure
  // step up, the same rule as Hiring now's row — so medium can qualify here as high, and the reason says why.
  const { byCompany: signalsBy } = await compoundByCompany(sb, [...byCompany.keys()], (await hasAwardDate(sb)) ? ', award_date, award_date_basis' : '');

  const out: { id: string; name: string; why: string; ageing: boolean; newest: string | null; sink: number; first: number }[] = [];
  for (const [id, ps] of byCompany) {
    const openings = ps.reduce((n, p) => n + (p.headcount && p.headcount > 0 ? p.headcount : 1), 0);
    const newest = ps.map((p) => p.posted_at ?? p.first_seen_at).filter(Boolean).sort().pop();
    const fresh = newest ? (Date.now() - Date.parse(newest)) / 86400000 <= 30 : false;
    const named = contacts ? ps.find((p) => p.contact_name) : null;
    const base: Pressure = openings >= 5 && fresh ? 'high' : openings >= 5 || (openings >= 2 && fresh) ? 'medium' : 'low';
    const signals = signalsBy.get(id);
    const lifted = signals && signals.factor > 1 ? boostedPressure(base, signals) : null;
    const high = (lifted?.pressure ?? base) === 'high';
    const liftedToHigh = high && base !== 'high';
    const byRole = new Map<string, any[]>();
    for (const p of ps) { const k = roleKey(p) || 'Trade role'; byRole.set(k, [...(byRole.get(k) ?? []), p]); }
    const raised = [...byRole.entries()].map(([role, list]) => ({ role, ...reAdverts(list) })).find((r) => r.boosted);
    if (!high && !named && !raised) continue;
    const age = ps.map((p) => postingAge(p)).sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity))[0];
    out.push({
      id,
      name: ps[0].companies?.name ?? 'a company',
      why: raised
        ? `${raised.role} re-advertised ${raised.count}× in ${REPOST_WINDOW_DAYS} days`
        : high ? (liftedToHigh ? `${openings} opening${openings === 1 ? '' : 's'}, pressure ${base} → high — ${signals!.label}` : `${openings} openings, newest within a month`) : `${named.contact_name} is named on the advert`,
      ageing: !raised && age.state === 'flagged',
      // The newest advert, already computed above for the pressure rule — returned now so Today can
      // put this company in the right window rather than guessing when it appeared.
      newest: newest ? String(newest) : null,
      sink: ageSink(age.state, !!raised),
      first: followedFirst(ps[0].companies?.industries),
    });
  }
  return out.sort((a, b) => (a.first - b.first) || (a.sink - b.sink)).slice(0, 5);
}

/** Which of the three things a 24-hour row is. The key is also the `data-source-group` on screen. */
export type Last24Group = 'news' | 'ted' | 'hiring';

export type Last24Row = {
  group: Last24Group;
  /** Lead id for news and TED, COMPANY id for hiring — the two tabs filter on different tables. */
  id: string;
  title: string;
  sub: string;
  /**
   * The sort key, and nothing else. For a lead it is the fit — boosted where the company carries two
   * signal types — and for a company it is its pressure mapped onto the same scale so one comparator can
   * order all three sources under "hottest first". It is NEVER rendered: a hiring row has no fit score,
   * and showing this as one would invent a number the database does not hold. Called `rank` rather than
   * `fit` so that cannot be mistaken later (owner's decision, 2026-09-18).
   */
  rank: number;
  boosted: boolean;
  /**
   * WHAT THE ROW SHOWS — the date the thing happened, not the moment we found it. A TED notice awarded
   * three weeks ago and crawled an hour ago belongs in this window and must read its award date; the
   * window itself filters on discovery (created_at / first_seen_at), which is a different question.
   */
  ts: string | null;
  /** What `ts` means, in the row's own words — never a bare date with no provenance. */
  tsBasis: string;
};

/** low/medium/high against the live lead distribution: leads sit at 80-88, so high ranks with a strong
 *  lead and low sits below the weakest one. Internal to the sort — see Last24Row.rank. */
const PRESSURE_RANK: Record<Pressure, number> = { low: 40, medium: 60, high: 80 };

/**
 * Everything discovered in the last 24 hours, hottest first, across all three sources.
 *
 * Deliberately NOT todayItems with a filter on it. Today's queue is a priority list of six leads and five
 * companies; this is every single thing that arrived in a rolling window, which needs a source type per
 * row, a fit to rank by, a timestamp to show, and an id to hand to ?ids= — none of which TodayItem has.
 *
 * Two dates per row, and conflating them is the mistake this is written to avoid. The WINDOW filters on
 * when we discovered a thing (leads.created_at, job_posts.first_seen_at); the row DISPLAYS when the thing
 * happened (published_at, award_date, posted_at). An advert posted in June and crawled this morning is
 * new to the recruiter and must say "posted 2026-06-14".
 *
 * Uncapped by design (owner's decision, 2026-09-18): measured at 3 leads and 7 postings in a real 24
 * hours, with the uncapped queries at ~0.12s. A hidden cap here would be the same fault as a silently
 * short ?ids= list — the card scrolls instead, and each group states its own count including zero.
 */
export async function last24h(
  sb: SupabaseClient,
  followed: IndustryId[] | 'all' = 'all',
  now = new Date(),
): Promise<{ rows: Last24Row[]; counts: Record<Last24Group, number>; since: string }> {
  const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const industriesOn = await hasIndustries(sb);
  const awardCols = (await hasAwardDate(sb)) ? ', award_date, award_date_basis' : '';
  const keep = (industries: string[] | null | undefined) =>
    followed === 'all' || (industries ?? []).length === 0 || (industries ?? []).some((i) => (followed as string[]).includes(i));

  const [leadsRes, postsRes] = await Promise.all([
    sb.from('leads')
      .select(`id, kind, company_id, country, project_name, fit_score, source_url, created_at, companies(name)${industriesOn ? ', industries' : ''}`)
      .eq('kind', 'won_work').not('status', 'in', '("stale","not_for_us")').gte('created_at', since),
    sb.from('job_posts')
      .select(`id, company_id, role, title, headcount, posted_at, first_seen_at, companies!inner(name${industriesOn ? ', industries' : ''})`)
      .eq('status', 'open').not('company_id', 'is', null).gte('first_seen_at', since),
  ]);

  const leads = ((leadsRes.data ?? []) as any[]).filter((l) => keep(l.industries));
  const posts = ((postsRes.data ?? []) as any[]).filter((p) => keep(p.companies?.industries));

  // Article dates for the leads in the window only, service-role — the same route todayItems uses,
  // because articles carry no read policy. A failure leaves the rows in place with no date rather than
  // dropping them: a lead that arrived is news whether or not its article date could be read.
  const { byLead } = await articlesByLead(leads.map((l) => l.id), awardCols);
  const { byCompany: signals } = await compoundByCompany(sb, [...leads.map((l) => l.company_id), ...posts.map((p) => p.company_id)], awardCols, now);

  const rows: Last24Row[] = [];

  for (const l of leads) {
    const a: any = primaryArticle(byLead.get(l.id) ?? [], l.source_url);
    const tender = leadSource(l.source_url) === 'tender';
    const c = signals.get(l.company_id);
    const lifted = c && c.factor > 1 ? boostedFit(l.fit_score ?? 0, c, l.country) : null;
    const award = tender ? (a?.award_date ?? null) : null;
    rows.push({
      group: tender ? 'ted' : 'news',
      id: String(l.id),
      title: l.companies?.name ?? 'a company',
      sub: l.project_name ?? (tender ? 'Contract award' : 'News mention'),
      rank: lifted?.fit ?? l.fit_score ?? 0,
      boosted: !!lifted,
      ts: award ?? a?.published_at ?? null,
      tsBasis: award ? (a?.award_date_basis || 'award date') : a?.published_at ? (tender ? 'award notice published' : 'article published') : 'no date on the source',
    });
  }

  // One row per COMPANY, not per advert: three adverts from one yard is one company to call, and the id
  // handed to ?ids= on the hiring tab is a company id.
  const byCompany = new Map<string, any[]>();
  for (const p of posts) (byCompany.get(p.company_id) ?? byCompany.set(p.company_id, []).get(p.company_id)!).push(p);
  for (const [id, ps] of byCompany) {
    // The same pressure rule Hiring now uses, reached rather than reinvented (hiringWorthCalling above).
    const openings = ps.reduce((n, p) => n + (p.headcount && p.headcount > 0 ? p.headcount : 1), 0);
    const newest = ps.map((p) => p.posted_at ?? p.first_seen_at).filter(Boolean).sort().pop();
    const fresh = newest ? (now.getTime() - Date.parse(String(newest))) / 86400000 <= 30 : false;
    const base: Pressure = openings >= 5 && fresh ? 'high' : openings >= 5 || (openings >= 2 && fresh) ? 'medium' : 'low';
    const c = signals.get(id);
    const lifted = c && c.factor > 1 ? boostedPressure(base, c) : null;
    const pressure = lifted?.pressure ?? base;
    const roles = [...new Set(ps.map((p) => roleKey(p) || 'Trade role'))];
    const posted = ps.map((p) => p.posted_at).filter(Boolean).sort().pop();
    rows.push({
      group: 'hiring',
      id: String(id),
      title: ps[0].companies?.name ?? 'a company',
      sub: `${openings} opening${openings === 1 ? '' : 's'} · ${roles.slice(0, 2).join(', ')}${roles.length > 2 ? ` +${roles.length - 2}` : ''} · pressure ${pressure}${lifted?.boosted ? ` (was ${base})` : ''}`,
      rank: PRESSURE_RANK[pressure],
      boosted: !!lifted?.boosted,
      // Sliced to a date because posted_at is a `date` and first_seen_at a `timestamptz`: the fallback
      // otherwise put "2026-09-18T12:25:40.048237+00:00" on screen beside rows reading "2026-09-17".
      // Same value, different shape, and the row is the only place a recruiter sees either.
      ts: (posted ?? ps.map((p) => p.first_seen_at).filter(Boolean).sort().pop() ?? null)?.slice(0, 10) ?? null,
      tsBasis: posted ? 'advert posted' : 'first seen by our crawl — the advert states no posting date',
    });
  }

  rows.sort((a, b) => (b.rank - a.rank) || String(a.title).localeCompare(String(b.title)));
  return {
    rows,
    counts: {
      news: rows.filter((r) => r.group === 'news').length,
      ted: rows.filter((r) => r.group === 'ted').length,
      hiring: rows.filter((r) => r.group === 'hiring').length,
    },
    since,
  };
}
