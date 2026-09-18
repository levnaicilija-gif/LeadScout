import { supabaseServer } from '@/lib/supabase/server';
import { followedIndustries, inFollowed } from '@/lib/industry-follow';
import { FOLLOW_OPTIONS } from '@/lib/industry';
import { Help } from '@/components/Help';
import { LeadDrawer } from '@/components/LeadDrawer';
import { HiringNow, HiringHelp } from '@/components/HiringNow';
import { hasEmployerOverride, hasJobBoardFields, hasHiringState, hasPostingContact, hasAwardDate, hasIndustries, hasDomainProvenance } from '@/lib/schema-features';
import { HiringDrawer } from '@/components/HiringDrawer';
import { groupByCompany } from '@/components/HiringNow';
import { checkRightToWork } from '@/lib/right-to-work';
import { currentUser } from '@/lib/supabase/server';
import { leadSource, LEAD_SOURCE_LABEL, LEAD_SOURCE_BADGE, SOURCE_FLAG_LABEL, primaryArticle } from '@/lib/lead-source';
import { newsLeadAge, tenderLeadAge, ageSink, latestActivityCompare, AGE_TEXT, AGE_DIM, type Age } from '@/lib/lead-age';
import { articlesByLead, peopleByLead } from '@/lib/lead-articles';
import { rankQuoted } from '@/lib/quoted-contacts';
import { OpenRow, OpenChevron } from '@/components/OpenRow';
import { compoundByCompany } from '@/lib/compound-signals-load';
import { preparedSearches } from '@/lib/hiring-contacts';
import { siteTrust } from '@/lib/site-trust';
import { boostedFit } from '@/lib/compound-signals';
export const dynamic = 'force-dynamic';
export default async function Radar({ searchParams }: { searchParams: { tab?: string; lead?: string; agencies?: string; company?: string; country?: string; trade?: string; employer?: string; pressure?: string; source?: string; sort?: string; industries?: string; since?: string; ids?: string; also?: string } }) {
  const sb = supabaseServer(); const tab = searchParams.tab === 'hiring' ? 'job_post' : 'won_work';
  const hiring = tab === 'job_post';
  // Item 18 part 3: Leads and Hiring now open on the industries this person follows. ?industries=all shows everything,
  // one click away on every view; the entitlement caps what is followed, never what can be seen. A lead or company
  // not yet classified (0031 before its backfill) is shown, not hidden.
  const viewer = await currentUser();
  const industriesOn = await hasIndustries(sb);
  const followed = followedIndustries((viewer as any)?.industry_follow);
  const showAll = searchParams.industries === 'all';
  const industryFilter = industriesOn && !showAll && followed !== 'all' ? followed : null;
  const viewQs = showAll ? '&industries=all' : '';
  const followedNames = followed === 'all' ? [] : FOLLOW_OPTIONS.filter((o) => o.industries.some((i) => (followed as string[]).includes(i))).map((o) => o.label);
  // Migration 0012 may not be applied yet; naming a column that does not exist fails the whole
  // query, so the override is only asked for once it is there.
  const ovr = await hasEmployerOverride(sb);
  const coOverride = ovr ? ", employer_type_override, employer_type_set_at" : "";
  const boards0014 = await hasJobBoardFields(sb);
  const jpBoard = boards0014 ? ", poster_name, poster_type, is_secondary, duplicate_of" : "";
  // 0020: row state on the company, and the contact printed on an advert.
  const state0020 = await hasHiringState(sb);
  const coState = state0020 ? ", hiring_status, hiring_confirmed_at" : "";
  const jpContact = (await hasPostingContact(sb)) ? ", contact_name, contact_title, contact_email" : "";

  // Today's queue item names a handful of companies, so its link shows exactly those (2026-09-17):
  // `ids` is this tab's set — lead ids on Won work, company ids on Hiring now — and `also` is the
  // other tab's, which is what lets the filtered view offer "+5 hiring now" without recomputing a
  // ranking that has moved on. Both are read as uuids and capped: the value comes from a URL, so a
  // hand-edited one must not be able to build an unbounded `.in()` or smuggle anything into a filter.
  // Declared above the postings query because that query filters on it — const is not hoisted, and
  // reading it from there before this line threw on the Hiring now tab (caught by typecheck).
  // The cap is 200, not 60 (owner's decision, 2026-09-18): a view that lists everything from the last 24
  // hours can name more than 60, and a click-through that quietly showed fewer rows than the view listed
  // would be the "count does not match" fault this filter exists to avoid. What the cap must never do is
  // drop items in silence, so the FULL parsed list is kept and the difference is carried to the banner —
  // a hidden cap and a silent truncation are the same bug one step apart.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ID_CAP = 200;
  const parseIds = (raw?: string) => (typeof raw === 'string' ? [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => UUID.test(s)))] : []);
  const idsAll = parseIds(searchParams.ids);
  const alsoAll = parseIds(searchParams.also);
  const ids = idsAll.slice(0, ID_CAP);
  const also = alsoAll.slice(0, ID_CAP);
  const idsDropped = idsAll.length - ids.length;
  // `also` gets the same treatment as `ids`, not a silently short count (owner's decision, 2026-09-18):
  // the cross-link reads "+5 hiring now →" straight off `also.length`, so a truncated `also` would
  // understate the other tab by exactly the number it dropped. Unreachable at today's volume — and so was
  // the ids path until it was made visible — but the tender-portal work and the 24h view both add source
  // volume, and a second matching gap left open is the kind that gets rediscovered as a bug rather than
  // found as a known edge.
  const alsoDropped = alsoAll.length - also.length;

  // Today's card opens this page filtered to what arrived while the recruiter was away. It is a
  // PARAMETER on the real Leads page, not a second table: the same columns, the same chips, the same
  // drawer. `since` is an ISO timestamp from users.last_seen_at, so it is the recruiter's own last
  // visit rather than a clock time (2026-09-17).
  // Parsed HERE, above the postings query, because that query filters on it from 2026-09-18 — const is
  // not hoisted, and reading it from there while it was declared below threw on the Hiring now tab the
  // last time this mistake was made with `ids`.
  const sinceRaw = typeof searchParams.since === 'string' ? searchParams.since : null;
  const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? new Date(sinceRaw).toISOString() : null;

  // Hiring now reads job_posts directly: a posting on a company's own careers page has no lead
  // behind it, and inventing one to hang it off would be a lead nobody decided to create.
  const { data: postings } = hiring
    ? await (() => {
      const q = sb.from('job_posts')
        .select(`id, company_id, title, role, location, country, trades, certs_required, rotation, contract_type, headcount, posted_at, first_seen_at, source_url, via${jpBoard}${jpContact}, companies!inner(name, employer_type, country, domain${coOverride}${coState}${industriesOn ? ', industries' : ''})`)
        .eq('status', 'open').not('company_id', 'is', null);
      // The named companies are filtered HERE rather than on the grouped rows, because this query keeps
      // only the newest 400 postings: a company whose adverts fall outside that window would vanish from
      // an array filter and the view would quietly show four of five with nothing saying so. With no ids
      // the filter is not applied at all — chaining one unconditionally would empty the whole tab.
      const named = ids.length ? q.in('company_id', ids) : q;
      // The time window, chained HERE for the same reason the ids filter is: this query keeps only the
      // newest 400 postings, so filtering the grouped rows afterwards would drop a company the count still
      // claimed. `first_seen_at` is the column that means "we discovered it" — which is what a "last 24
      // hours" window asks — while `posted_at` is what a row DISPLAYS, and can be months earlier on an
      // advert we only just crawled (2026-09-18).
      const inWindow = since ? named.gte('first_seen_at', since) : named;
      return inWindow.order('posted_at', { ascending: false, nullsFirst: false }).order('first_seen_at', { ascending: false }).limit(400);
    })()
    : { data: null };
  const { count: boards } = hiring
    ? await sb.from('companies').select('id', { count: 'exact', head: true }).eq('careers_status', 'found')
    : { count: 0 };

  // Every source linked to a lead, without its text: the tag needs the URLs, and a second source
  // on the same contract is shown as corroboration rather than as a second row.
  //
  // News and award notices are read as two lists of 50. One list of 50 by fit let the first TED
  // backfill fill 45 of the 50 rows: an award with no named person scores the same 80 as a story
  // with a quoted decision-maker, and 20 of the 25 open news leads fell off the page. Within the
  // merged list a quoted decision-maker wins a tie on fit. ?source= narrows to one kind.
  const source = searchParams.source === 'news' || searchParams.source === 'tender' ? searchParams.source : null;
  // ?sort=latest — "Latest activity". It reads every open lead rather than the top 50 of each kind by fit:
  // sorting only those would bury a recent award whose fit is low (BEIRENS and two others were not loaded at all).
  const latest = searchParams.sort === 'latest';
  const sortQs = latest ? '&sort=latest' : '';
  // Item 18 part 1: ?country= on Won work, as Hiring now has. The chips come from the countries the open won-work
  // leads actually carry — all of them, not the 50 per kind on screen, or a country outside the top 50 has no chip.
  const country = !hiring && typeof searchParams.country === 'string' && /^[A-Z]{2}$/.test(searchParams.country) ? searchParams.country : null;
  // Today's card opens this page filtered to what arrived while the recruiter was away. It is a
  // PARAMETER on the real Leads page, not a second table: the same columns, the same chips, the same
  // drawer. `since` is an ISO timestamp from users.last_seen_at, so it is the recruiter's own last
  // visit rather than a clock time (2026-09-17). Declared here, above countryQs, because every link
  // the page builds threads it through that string — a source chip, a sort chip, a country chip or a
  // row href that dropped it would silently clear the filter on the first click.
  // `since` itself is parsed further up, above the postings query that filters on it.
  const sinceQs = since ? `&since=${encodeURIComponent(since)}` : '';
  const idsQs = ids.length ? `&ids=${ids.join(',')}${also.length ? `&also=${also.join(',')}` : ''}` : '';
  const countryQs = (country ? `&country=${country}` : '') + viewQs + sinceQs + idsQs;
  // 0024 gives an award notice its own award date; before it, an award lead ages from the notice's publication.
  const awardCols = (await hasAwardDate(sb)) ? ', award_date, award_date_basis' : '';
  // Item 21: the quoted contact's address and where it came from (the embed never loaded email or quote, so the drawer
  // could show neither), and what the company's own site gave — switchboard, general email, people — with sources.
  // 0033: how the website was found and checked. Named only once it exists — a missing column fails the whole query.
  const domainCols = (await hasDomainProvenance(sb)) ? ', domain_source, domain_address_check, domain_checked_address, domain_scope, domain_scope_reason' : '';
  const leadCols = `*, companies(name, domain, country, source, employer_type, size_band, switchboard, switchboard_source_url, general_email, general_email_source_url, contacts_checked_at${coOverride}${domainCols}, contacts(name, title, email, email_status, email_source_url, phone, phone_source_url, source_url, lead_id, linkedin_search_url, google_search_url)), contacts(name, title, quote, email, email_status, email_source_url, phone, phone_source_url, linkedin_search_url, google_search_url), job_posts(role, headcount, certs_required, hiring_pressure, posted_at)`;
  const openLeads = (cols: string, head = false) => {
    const q = sb.from('leads').select(cols, head ? { count: 'exact', head: true } : undefined).eq('kind', tab).not('status', 'in', '("stale","not_for_us")');
    const inCountry = country ? q.eq('country', country) : q;
    const inWindow = since ? inCountry.gte('created_at', since) : inCountry;
    // Named leads, in the closure every query and count goes through — the table, both source counts and
    // the chip numbers narrow together. Filtering the rows after the fact would leave the banner counting
    // one set and the table showing another.
    const named = !hiring && ids.length ? inWindow.in('id', ids) : inWindow;
    return industryFilter ? named.or(`industries.ov.{${industryFilter.join(',')}},industries.eq.{}`) : named;
  };
  // What the same query says with no filter, so the banner can offer the whole list by number.
  const { count: everyOpen } = since || ids.length
    ? await sb.from('leads').select('id', { count: 'exact', head: true }).eq('kind', tab).not('status', 'in', '("stale","not_for_us")')
    : { count: null as number | null };
  const NEWS_ONLY = 'source_url.is.null,source_url.not.ilike.https://ted.europa.eu/*';
  const TENDER_URL = 'https://ted.europa.eu/%';
  const none = { data: [] as any[], error: null as any };
  const [newsRes, tenderRes, newsCount, tenderCount] = hiring ? [none, none, { count: 0 }, { count: 0 }] : await Promise.all([
    source === 'tender' ? none : openLeads(leadCols).or(NEWS_ONLY).order('fit_score', { ascending: false }).limit(latest ? 1000 : 50),
    source === 'news' ? none : openLeads(leadCols).ilike('source_url', TENDER_URL).order('fit_score', { ascending: false }).limit(latest ? 1000 : 50),
    openLeads('id', true).or(NEWS_ONLY),
    openLeads('id', true).ilike('source_url', TENDER_URL),
  ]);
  const leadsError = (newsRes as any).error ?? (tenderRes as any).error ?? null;
  const { count: everyIndustry } = !hiring && industryFilter
    ? await (() => { const q = sb.from('leads').select('id', { count: 'exact', head: true }).eq('kind', tab).not('status', 'in', '("stale","not_for_us")'); return country ? q.eq('country', country) : q; })()
    : { count: null as number | null };
  const { data: countryRows, error: countriesError } = hiring
    ? { data: null, error: null }
    : await sb.from('leads').select('country').eq('kind', 'won_work').not('status', 'in', '("stale","not_for_us")').not('country', 'is', null).limit(5000);
  const leadCountries = [...new Set(((countryRows ?? []) as any[]).map((r) => String(r.country)))].sort();
  const hasContact = (l: any) => ((l.contacts?.length ?? 0) > 0 ? 1 : 0);
  // Item 17: how old the signal is, from the article the lead stands on. Computed here and never
  // stored; an ageing or stale lead sorts lower and dims, and is never hidden or re-statused.
  const ageOf = (l: any): Age => {
    const a: any = primaryArticle(l.lead_articles, l.source_url);
    return leadSource(l.source_url) === 'tender'
      ? tenderLeadAge({ awardDate: a?.award_date, awardBasis: a?.award_date_basis, publishedAt: a?.published_at, awardDateRead: !!awardCols })
      : newsLeadAge({ publishedAt: a?.published_at });
  };
  // The sources behind each lead: read with the service role for the leads this user already loaded,
  // because articles and lead_articles have no read policy until 0025 (src/lib/lead-articles.ts).
  const loaded = [...((newsRes as any).data ?? []), ...((tenderRes as any).data ?? [])] as any[];
  const { byLead, error: linksError } = await articlesByLead(loaded.map((l) => l.id), awardCols);
  for (const l of loaded) l.lead_articles = byLead.get(l.id) ?? [];
  const { byLead: peopleBy, error: peopleError } = await peopleByLead(loaded.map((l) => l.id));
  for (const l of loaded) l.lead_people = peopleBy.get(l.id) ?? [];
  // Item 21: people read off the company's own site hang from the company (lead_id null), found once per company by the
  // discovery pass and shown on every lead that company stands behind. A quoted person already on the lead is not
  // repeated. With nothing at all, the drawer offers prepared searches — searches, never contacts.
  for (const l of loaded) {
    const quotedNames = new Set((l.contacts ?? []).map((c: any) => String(c.name).toLowerCase()));
    l.company_people = (l.companies?.contacts ?? []).filter((c: any) => !c.lead_id && c.source_url && !quotedNames.has(String(c.name).toLowerCase()));
    l.searches = preparedSearches(l.companies?.name ?? '');
    // Whether the site those contacts came from is confirmed against the award notice, and whether it is the group's.
    l.site_trust = siteTrust(l.companies);
  }
  // Item 19: a company with two or more independent signal types inside 60 days — tender award, news mention, open
  // posting, re-advertised role — raises the fit of every one of its leads. Computed here and never stored: the row
  // shows the boost and what it was before, the drawer the full reason, and the Fit sort uses the boosted figure.
  // Hiring now (step 2): the same signals lift a company's pressure one step, for every company with an open posting here.
  const { byCompany: compounds, error: compoundError } = await compoundByCompany(
    sb, hiring ? ((postings ?? []) as any[]).map((p) => p.company_id) : loaded.map((l) => l.company_id), awardCols,
  );
  const compoundsByCompany = Object.fromEntries(compounds);
  for (const l of loaded) {
    const c = compounds.get(l.company_id);
    if (!c || c.factor <= 1) continue;
    const b = boostedFit(l.fit_score ?? 0, c, l.country);
    l.fit_boost = { from: b.from, to: b.fit, label: c.label, note: b.note };
    l.fit_score = b.fit;
  }
  const leads = loaded
    .map((l: any) => ({ ...l, age: ageOf(l) }))
    // Fit (the default): ageing and stale sink below fresh and undated, then fit. Latest activity: Fresh,
    // Ageing, Stale, then Age unknown, newest first within each; fit breaks a tie, including between undated rows.
    .sort((a: any, b: any) => latest
      ? (latestActivityCompare(a.age, b.age) || (b.fit_score - a.fit_score) || (hasContact(b) - hasContact(a)))
      : ((ageSink(a.age.state) - ageSink(b.age.state)) || (b.fit_score - a.fit_score) || (hasContact(b) - hasContact(a))));
  // The table and the drawer show contacts[0]; an embed has no order, so put the best one first by
  // item 14's rank — whoever is closest to the work, above a group executive.
  for (const l of leads as any[]) {
    if ((l.contacts?.length ?? 0) < 2) continue;
    const project = { name: l.project_name, location: l.project_location };
    l.contacts = [...l.contacts].sort((a: any, b: any) => rankQuoted({ name: a.name, title: a.title ?? '' }, project).rank - rankQuoted({ name: b.name, title: b.title ?? '' }, project).rank);
  }
  // Postgres puts NULLs first on DESC, so without the not-null filter this picked an
  // uncrawled source and 'Last read' always said never, however often Radar had run.
  const { data: last } = await sb.from('sources').select('last_crawled_at').not('last_crawled_at', 'is', null).order('last_crawled_at', { ascending: false }).limit(1).maybeSingle();
  const { data: lastJobs } = await sb.from('companies').select('last_jobs_crawl_at').not('last_jobs_crawl_at', 'is', null).order('last_jobs_crawl_at', { ascending: false }).limit(1).maybeSingle();
  // Agencies are hidden unless asked for: a competitor's vacancy is not customer demand. The
  // count of what is hidden stays visible, so the market view is one click away.
  const showAgencies = searchParams.agencies === '1';
  const isAgency = (p: any) => (p.companies?.employer_type_override ?? p.companies?.employer_type) === 'staffing_agency';
  // A board advert that merely repeats a company's own careers page adds noise, not news.
  const notDuplicate = (p: any) => !p.duplicate_of;
  const shown = (postings ?? []).filter(notDuplicate);
  const duplicates = (postings ?? []).length - shown.length;
  const agencyPostings = shown.filter(isAgency);
  // A row marked "not for us" is a decision, and it stays taken: it leaves the table.
  const notRejected = (p: any) => (p.companies?.hiring_status ?? 'new') !== 'not_for_us';
  const liveEvery = shown.filter(notRejected);
  const live = industryFilter ? liveEvery.filter((p: any) => inFollowed(p.companies?.industries, industryFilter)) : liveEvery;
  const rejected = shown.length - liveEvery.length;

  // Verified candidates by trade, for "Ready to attach". One query, not one per row.
  const { data: readyRows } = hiring
    ? await sb.from('verifications')
      .select('result, documents!inner(candidates!candidate_id(trade))')
      .eq('result', 'valid').limit(300)
    : { data: null as any };
  const readyCounts = new Map<string, number>();
  for (const v of (readyRows ?? []) as any[]) {
    const t = (v.documents?.candidates?.trade ?? '').toLowerCase();
    if (!t) continue;
    for (const word of t.split(/[^a-z]+/).filter(Boolean)) readyCounts.set(word, (readyCounts.get(word) ?? 0) + 1);
  }

  const agencyFiltered = (showAgencies ? live : live.filter((p: any) => !isAgency(p))) as any[];
  const groupsAll = hiring ? groupByCompany(agencyFiltered as any, compoundsByCompany) : [];
  const options = {
    countries: [...new Set(groupsAll.map((g) => g.country).filter(Boolean))].sort() as string[],
    trades: [...new Set(groupsAll.flatMap((g) => g.trades))].sort(),
    employers: [...new Set(groupsAll.map((g) => g.employerType ?? 'unknown'))].sort(),
  };
  const state: Record<string, { confirmedAt?: string | null; status?: string | null }> = {};
  for (const p of agencyFiltered) {
    state[p.company_id] = { confirmedAt: p.companies?.hiring_confirmed_at ?? null, status: p.companies?.hiring_status ?? null };
  }
  // One right-to-work line per country in view, keyed on where the work is.
  const rightToWork: Record<string, string> = {};
  for (const c of options.countries) rightToWork[c] = checkRightToWork(c, {} as any).rule;

  const openCompany = searchParams.company
    ? (groupsAll.find((g) => g.companyId === searchParams.company) ?? groupByCompany(((showAgencies ? liveEvery : liveEvery.filter((p: any) => !isAgency(p))) as any), compoundsByCompany).find((g) => g.companyId === searchParams.company)) ?? null
    : null;

  const hiringProps = {
    postings: agencyFiltered as any,
    crawledAt: lastJobs?.last_jobs_crawl_at,
    companiesWithBoards: boards ?? 0,
    showAgencies,
    hiddenAgencies: agencyPostings.length,
    duplicates,
    filters: { country: searchParams.country, trade: searchParams.trade, employer: searchParams.employer, pressure: searchParams.pressure, sort: searchParams.sort },
    options,
    state,
    rightToWork,
    compounds: compoundsByCompany,
  };

  const selected = leads?.find((l) => l.id === searchParams.lead) ?? null;
  const hiringCompaniesEvery = hiring && industryFilter ? new Set((showAgencies ? liveEvery : liveEvery.filter((p: any) => !isAgency(p))).map((p: any) => p.company_id)).size : null;
  const shownWon = (newsCount.count ?? 0) + (tenderCount.count ?? 0);
  // What "see all" actually means on each tab. everyOpen counts leads of this kind, which is right for Won
  // work and wrong for Hiring now — there `kind` is job_post, so it would count job-post LEADS rather than
  // companies advertising, and the banner would offer a number that means nothing on the screen it is on.
  // Counted only while a filter is on, and never for the ids case on Won work, where everyOpen already says it.
  // Fires for `since` as well as `ids` (2026-09-18): with a time filter on this tab and this count left
  // null, everyHere fell back to groupsAll.length — the FILTERED number — so "Clear filter — see all N"
  // offered exactly the count it was clearing. A link that promises what is already on screen is worse
  // than no link at all.
  const everyHiringCompany = hiring && (ids.length || since)
    ? await (async () => {
      const { data } = await sb.from('job_posts').select('company_id').eq('status', 'open').not('company_id', 'is', null).limit(2000);
      return new Set(((data ?? []) as any[]).map((p) => p.company_id)).size;
    })()
    : null;
  const filtered = since || ids.length > 0;
  const shownHere = hiring ? groupsAll.length : shownWon;
  const everyHere = hiring ? (everyHiringCompany ?? groupsAll.length) : (everyOpen ?? shownWon);
  const followBanner = (showAll && followed !== 'all' && industriesOn)
    ? <div data-industry-view="all" className="text-[13px] mb-3">Showing all industries · <a className="text-accent font-semibold" href={`?tab=${hiring ? 'hiring' : 'won'}`}>back to yours ({followedNames.join(', ')})</a></div>
    : industryFilter
      ? <div data-industry-view="followed" className="text-[13px] mb-3">Showing {hiring ? `${groupsAll.length} of ${hiringCompaniesEvery ?? groupsAll.length} companies` : `${shownWon} of ${everyIndustry ?? shownWon} open leads`} in your industries ({followedNames.join(', ')}) · <a data-show-all-industries className="text-accent font-semibold" href={`?tab=${hiring ? 'hiring' : 'won'}&industries=all`}>show all industries</a> · <a className="text-ink3" href="/app/preferences">change</a></div>
      : null;
  return (<>
    <div className="flex items-baseline justify-between flex-wrap gap-x-3 gap-y-1 mb-3"><h1 className="font-display text-[26px] font-bold tracking-[-.4px]">Leads{hiring ? <HiringHelp /> : <Help title="What Radar is" intro="Reads your sources every morning and tells you which companies will need people, and who to talk to." rows={[['Won work', 'Company won a contract; the person quoted by name; when the work starts.'], ['News / Tender award', 'News is a story Radar read. Tender award is a contract award notice from TED: the buyer, the winner, the value — and no quoted person. The same contract from both is one row, the second source linked.'], ['Hiring now', 'Open trade postings, certs asked for, who to contact — from the posting, company site or Industry Contacts.'], ['Verified', 'Source re-fetched each morning; Confirm records that you checked it. Outreach needs both.'], ['Age', 'A news lead is ageing at 45 days and a stale signal at 90, from the article\'s date; an award at 180 and 365, from the award date. Older leads sink and dim — never hidden, never re-statused. No date says "age unknown".'], ['Boosted', 'A company with two or more independent signals inside 60 days — a tender award, a news mention, an open advert (a re-advertised role is the same signal, stronger, never a second one) — has every lead\'s fit raised ×1.1 for each signal beyond the first, capped at 100 (25 outside Europe). The row names the signals and the fit before; the drawer gives each date. One signal changes nothing.'], ['Never', 'Invents a name, an email, a phone or a job opening.']]} />}</h1><span className="text-ink3">{last?.last_crawled_at ? `Last read ${new Date(last.last_crawled_at).toLocaleString()}` : 'Not read yet'}{tab === 'job_post' ? ` · careers pages ${lastJobs?.last_jobs_crawl_at ? new Date(lastJobs.last_jobs_crawl_at).toLocaleDateString() : 'not crawled yet'}` : ''}</span></div>
    {/* v4 segmented control: the tab you are on is the navy one, not an underline.
        It carries the filter across, like every other link on this page (2026-09-18). It was the ONE that
        threaded nothing — `?tab=hiring` and nothing else — so switching tabs from a filtered view silently
        dropped the filter and landed on the whole list with no banner to say what had happened. Clearing is
        the Clear filter link's job, never a side effect of navigating.
        `ids` SWAP rather than carry: they are lead ids on Won work and company ids on Hiring now, so handing
        them straight over would filter company_id against lead ids and match nothing — a filtered view of
        zero rows, which is worse than the bug it replaced. `also` is already the other tab's set, so the two
        change places, exactly as the cross-link between them does. `source` and `country` are Won-work's own
        (country is gated on !hiring), so they go only when Won work is where we are heading. */}
    <div className="flex gap-1 bg-panel border border-line rounded-[12px] p-1 w-max mb-3.5">{[['won', 'Won work'], ['hiring', 'Hiring now']].map(([t, l]) => {
      const toHiring = t === 'hiring';
      const staying = toHiring === hiring;
      const nextIds = staying ? ids : also;
      const nextAlso = staying ? also : ids;
      const href = `?tab=${t}`
        + (!toHiring && source ? `&source=${source}` : '')
        + sortQs
        + (!toHiring && country ? `&country=${country}` : '')
        + viewQs
        + sinceQs
        + (nextIds.length ? `&ids=${nextIds.join(',')}${nextAlso.length ? `&also=${nextAlso.join(',')}` : ''}` : '');
      return <a key={t} data-tab={t} href={href} className={`px-3.5 py-2 rounded-[9px] font-medium ${(t === 'hiring') === (tab === 'job_post') ? 'bg-rail text-white' : 'text-ink2 hover:bg-line2'}`}>{l}</a>;
    })}</div>
    {filtered && (
      <div data-since-filter={since ? '' : undefined} data-ids-filter={ids.length ? ids.length : undefined} className="mb-3 rounded-card border border-accent bg-accentsoft px-4 py-3 flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <b className="font-semibold text-accent">Showing {hiring ? `${shownHere} compan${shownHere === 1 ? 'y' : 'ies'}` : `${shownHere} of ${everyHere} open leads`}</b>
          <div className="text-[12px] text-ink2 mt-0.5">
            {since
              ? <>Found since {new Date(since).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} — your last visit, not a fixed clock time</>
              : <>The {hiring ? 'companies' : 'leads'} today&apos;s queue named — these {shownHere} and nothing else{also.length > 0 && <>, {hiring ? 'read beside' : 'and'} {also.length} on the other tab</>}</>}
          </div>
          {/* Said out loud, never swallowed: the line above claims "these N and nothing else", and a silent
              truncation would make that claim false. 200 is the cap; anything past it is named here rather
              than dropped quietly, which is the whole reason the full parsed list is kept at the top. */}
          {idsDropped > 0 && (
            <div data-ids-truncated={idsDropped} className="mt-1 text-[12px] font-semibold text-warn">
              {idsDropped} more {hiring ? 'compan' : 'lead'}{idsDropped === 1 ? (hiring ? 'y was' : ' was') : (hiring ? 'ies were' : 's were')} named than this filter carries ({ID_CAP} at a time) — they are not shown here.
            </div>
          )}
          {/* The same again for `also`, and the noun INVERTS: the line above describes this tab, while the
              cross-link beside it describes the other one — "+N hiring now" is companies when we are on Won
              work, "← N won work" is leads when we are on Hiring now. A sentence that reads plausibly and
              names the wrong table is worse than an obvious error, so this follows the link's own label. */}
          {alsoDropped > 0 && (
            <div data-also-truncated={alsoDropped} className="mt-1 text-[12px] font-semibold text-warn">
              {alsoDropped} more {hiring ? 'lead' : 'compan'}{alsoDropped === 1 ? (hiring ? ' was' : 'y was') : (hiring ? 's were' : 'ies were')} named than the {hiring ? '← won work' : '+ hiring now'} link carries ({ID_CAP} at a time) — they are not shown here.
            </div>
          )}
        </div>
        <span className="flex items-baseline gap-3 flex-wrap">
          {/* The other half of the same queue item: six leads and five companies are different tables on
              different tabs, so one filtered view cannot hold both — it links across instead. */}
          {!since && also.length > 0 && (
            <a data-also-link className="text-[12.5px] font-semibold text-accent" href={`/app/radar?tab=${hiring ? 'won' : 'hiring'}&ids=${also.join(',')}&also=${ids.join(',')}`}>
              {hiring ? `← ${also.length} won work` : `+${also.length} hiring now →`}
            </a>
          )}
          <a data-clear-since className="text-[12.5px] font-semibold text-accent" href={`?tab=${hiring ? 'hiring' : 'won'}${source ? `&source=${source}` : ''}${sortQs}${country ? `&country=${country}` : ''}${viewQs}`}>
            Clear filter — see all {everyHere} →
          </a>
        </span>
      </div>
    )}
    {followBanner}
    {hiring && compoundError && <div className="mb-3 text-bad text-[13px]">A company's other signals could not be read: {compoundError}. No pressure below is boosted, which may be wrong.</div>}
    {hiring ? <HiringNow {...hiringProps} /> : (
    <>
    <div className="flex items-center gap-1.5 flex-wrap mb-3" data-source-filter>{([[null, "All", (newsCount.count ?? 0) + (tenderCount.count ?? 0)], ["news", "News", newsCount.count ?? 0], ["tender", "Tender awards", tenderCount.count ?? 0]] as const).map(([k, label, n]) => <a key={label} href={k ? `?tab=won&source=${k}${sortQs}${countryQs}` : `?tab=won${sortQs}${countryQs}`} className={`chip ${source === k ? "!bg-rail !text-white !border-rail" : ""}`}>{label} <span className={source === k ? "text-white/70" : "text-ink3"}>{n}</span></a>)}</div>
    <div data-sort-control className="flex items-center gap-1.5 flex-wrap mb-3 text-[13px]"><span className="text-ink3">Sort</span>{([[false, 'Fit'], [true, 'Latest activity']] as const).map(([isLatest, label]) => <a key={label} data-sort={isLatest ? 'latest' : 'fit'} href={`?tab=won${source ? `&source=${source}` : ''}${isLatest ? '&sort=latest' : ''}${countryQs}`} className={`chip ${latest === isLatest ? '!bg-rail !text-white !border-rail' : ''}`}>{label}</a>)}{latest && <span className="text-ink3 text-[12px]">Fresh, then ageing, then stale, then age unknown — newest first within each · all {leads.length} open leads{source ? '' : ', news and awards together'}</span>}</div>
    {leadCountries.length >= 2 && <div data-country-filter className="flex items-center gap-1.5 flex-wrap mb-3 text-[13px]"><span className="text-ink3">Country</span>{leadCountries.map((c) => <a key={c} data-country={c} href={`?tab=won${source ? `&source=${source}` : ''}${sortQs}${country === c ? '' : `&country=${c}`}${viewQs}`} className={`chip ${country === c ? '!bg-rail !text-white !border-rail' : ''}`}>{c}</a>)}{country && <span className="text-ink3 text-[12px]">Showing leads in {country} only · <a className="text-accent" href={`?tab=won${source ? `&source=${source}` : ''}${sortQs}${viewQs}`}>all countries</a></span>}</div>}
    {countriesError && <div className="mb-3 text-bad text-[13px]">The countries on these leads could not be read: {countriesError.message}. The country filter is missing, not empty.</div>}
    <div data-drawer-help className="text-[13px] mb-2"><span className="text-ink3">Click or tap a lead to open its drawer</span><Help title="What opens when you click a lead" intro="The lead's drawer: its source and whether you have confirmed it, what the company is, and the decision-maker with their quote and where any email or phone came from. Below that, the four tools (job description, score the pool, LinkedIn search, screening questions), a drafted email that needs the source confirmed first, and Mark pursued or Not for us." /></div>
    {leadsError && <div className="mb-3 text-bad text-[13px]">Leads could not be read: {leadsError.message}. The table below is incomplete, not empty.</div>}
    {linksError && <div className="mb-3 text-bad text-[13px]">The sources behind these leads could not be read: {linksError}. Ages and linked sources below are incomplete — a lead reading "age unknown" may have a date.</div>}
    {peopleError && <div className="mb-3 text-bad text-[13px]">The Industry Contacts behind these leads could not be read: {peopleError}. A lead showing nobody may have people on file.</div>}
    {compoundError && <div className="mb-3 text-bad text-[13px]">A company's other signals could not be read: {compoundError}. No fit below is boosted, which may be wrong.</div>}
    <div className="bg-panel border border-line rounded-card overflow-auto max-h-[calc(100vh-240px)]"><table className="tbl w-full min-w-[1100px] border-collapse">
      <thead><tr><th>Company</th><th>{tab === 'won_work' ? 'Won' : 'Open roles'}</th><th>Decision-maker</th><th>Trades</th><th>{tab === 'won_work' ? 'Phase' : 'Pressure'}</th><th>Fit</th><th>Verified</th></tr></thead>
      <tbody>{(leads ?? []).map((l: any) => { const c = l.contacts?.[0]; const jp = l.job_posts?.[0]; const src = leadSource(l.source_url); const also = Math.max(0, (l.lead_articles?.length ?? 0) - 1); return (
        <OpenRow key={l.id} href={`/app/radar?tab=${searchParams.tab ?? 'won'}${source ? `&source=${source}` : ''}${sortQs}${countryQs}&lead=${l.id}`} selected={selected?.id === l.id} className={AGE_DIM[l.age.state as keyof typeof AGE_DIM]} attrs={{ 'data-lead-source': src, 'data-age': l.age.state, 'data-age-date': l.age.date ?? '' }}>
          <td><a href={`?tab=${searchParams.tab ?? 'won'}${source ? `&source=${source}` : ''}${sortQs}${countryQs}&lead=${l.id}`} className="block"><div className="font-medium whitespace-nowrap flex items-center gap-1.5">{l.companies?.name}<OpenChevron /></div><div className="text-ink3 text-[12px]">{l.project_location} · {l.companies?.employer_type?.replace('_', ' ')}{l.companies?.size_band ? ` · ${l.companies.size_band}` : ''}</div><div className="mt-1.5 flex items-center gap-1.5 flex-wrap"><span data-source={src} className={LEAD_SOURCE_BADGE[src]}>{LEAD_SOURCE_LABEL[src]}</span><span data-age-label title={l.age.why} className={`text-[12px] ${AGE_TEXT[l.age.state as keyof typeof AGE_TEXT]}`}>{l.age.label}</span>{also > 0 && <span className="text-ink3 text-[12px]" title="The same contract, reported by another source, linked to this lead">+{also} source{also === 1 ? '' : 's'}</span>}</div>{l.fit_boost && <div data-compound title={l.fit_boost.note} className="mt-1 text-[12px] text-accent font-medium whitespace-normal">{l.fit_boost.label}</div>}</a></td>
          <td>{tab === 'won_work' ? l.project_name : jp?.role}<div className="text-ink3 text-[12px]">{tab === 'won_work' ? [l.phase, l.project_value].filter(Boolean).join(' · ') : `${jp?.headcount ? `×${jp.headcount} · ` : ''}posted ${jp?.posted_at ?? '—'}`}</div></td>
          <td>{c ? <><div className="font-medium">{c.name} <a href={c.linkedin_search_url} target="_blank" rel="noopener" className="ml-1 inline-grid place-items-center w-5 h-5 border border-line rounded text-[10px] font-semibold text-ink2">in</a> <a href={c.google_search_url} target="_blank" rel="noopener" className="inline-grid place-items-center w-5 h-5 border border-line rounded text-[10px] font-semibold text-ink2">G</a></div><div className="text-ink3 text-[12px]">{c.title} · email {c.email_status}{c.phone ? ' · phone found' : ''}</div></> : l.company_people?.[0] ? <div data-company-contact><div className="font-medium">{l.company_people[0].name}</div><div className="text-ink3 text-[12px]">{l.company_people[0].title} · from their site{l.company_people[0].email ? ' · email found' : ''}{l.company_people[0].phone ? ' · phone found' : ''}{l.site_trust?.rowNote && <span data-site-note className="text-warn font-medium"> · {l.site_trust.rowNote}</span>}</div></div>
            : (l.companies?.switchboard || l.companies?.general_email) ? <div data-company-contact><div className="font-medium">{l.companies.switchboard ? 'Switchboard' : 'General email'}</div><div className="text-ink3 text-[12px]">{l.companies.switchboard ?? l.companies.general_email} · from their site{l.site_trust?.rowNote && <span data-site-note className="text-warn font-medium"> · {l.site_trust.rowNote}</span>}</div></div>
            : <span className="text-ink3">— {l.lead_people?.length ? `${l.lead_people.length} from Industry Contacts` : src === 'tender' ? 'award notices name no person' : 'no named person'}</span>}</td>
          <td>{(l.trades_inferred ?? []).map((t: string) => <span key={t} className="inline-block text-[12px] px-2 py-0.5 rounded-md bg-line2 text-ink2 mr-1 mb-1">{t}</span>)}</td>
          <td>{tab === 'won_work' ? <span className="text-[13px]">{l.phase_start ?? l.phase ?? '—'}</span> : <span className={`st ${jp?.hiring_pressure === 'high' ? 'st-bad' : jp?.hiring_pressure === 'medium' ? 'st-warn' : ''}`}>{jp?.hiring_pressure ?? 'low'}</span>}</td>
          <td><span className="inline-flex items-center gap-2 font-semibold"><i className="inline-block w-[56px] h-[6px] rounded-full bg-line overflow-hidden"><i className="block h-full rounded-full bg-tool-leads" style={{ width: `${l.fit_score}%` }} /></i>{l.fit_score}</span>{l.fit_boost && <div data-fit-from title={l.fit_boost.note} className="text-ink3 text-[12px] whitespace-nowrap">{l.fit_boost.to === l.fit_boost.from ? 'boost held by the cap' : `boosted, was ${l.fit_boost.from}`}</div>}</td>
          <td className="whitespace-nowrap"><span className={`badge ${l.source_fetch_status === 'live' ? (l.confirmed_at ? 'badge-ok' : 'badge-info') : 'badge-bad'}`}>{l.confirmed_at ? '✓ ' : ''}{l.source_fetch_status}{l.confirmed_at ? ' · confirmed' : ' · not confirmed'}</span><div className="text-[12px] mt-1"><a href={l.source_url} target="_blank" rel="noopener" className="text-accent font-medium">Open source</a></div>{l.source_flag && l.source_flag !== 'ok' && <div data-source-flag={l.source_flag} title={l.source_flag_why ?? ''} className="text-[12px] mt-1 text-warn">{SOURCE_FLAG_LABEL[l.source_flag] ?? l.source_flag}</div>}</td>
        </OpenRow>); })}
      {(leads ?? []).length === 0 && <tr><td colSpan={7} className="text-ink3 p-6">{industryFilter && (everyIndustry ?? 0) > 0
        ? <span data-no-followed-leads>No open leads in your industries ({followedNames.join(', ')}){country ? ` in ${country}` : ''} yet. <a className="text-accent font-semibold" href={`?tab=won${source ? `&source=${source}` : ''}${sortQs}${country ? `&country=${country}` : ''}&industries=all`}>Show all {everyIndustry} open leads</a></span>
        : country ? `No open leads in ${country}${source ? ` from ${source === 'news' ? 'news' : 'tender awards'}` : ''}.` : 'No leads yet. Radar reads your sources and the TED award notices every morning at 06:00.'}</td></tr>}
      </tbody></table></div></>)}
    {selected && <LeadDrawer lead={selected} />}
    {openCompany && (
      <HiringDrawer g={{
        companyId: openCompany.companyId,
        company: openCompany.company,
        employerType: openCompany.employerType,
        employerOverride: (openCompany.postings[0] as any)?.companies?.employer_type_override ?? null,
        employerSetAt: (openCompany.postings[0] as any)?.companies?.employer_type_set_at ?? null,
        country: openCompany.country,
        postings: openCompany.postings,
        trades: openCompany.trades,
        certs: openCompany.certs,
        pressure: openCompany.pressure,
        pressureWhy: openCompany.pressureWhy,
        compound: openCompany.compound,
        confirmedAt: state[openCompany.companyId]?.confirmedAt ?? null,
        status: state[openCompany.companyId]?.status ?? null,
        readyByTrade: openCompany.trades
          .map((t) => ({ trade: t, n: readyCounts.get(t.split(' ')[0].toLowerCase()) ?? 0 }))
          .filter((x) => x.n > 0),
      }} />
    )}
  </>);
}
