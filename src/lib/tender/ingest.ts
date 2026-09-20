/**
 * Contract awards from TED, into the same leads Radar makes.
 *
 * An award notice is stored as an article — the fetched page every lead already stands on — and
 * each winning company becomes a won-work lead linked to it. So the lead drawer's tools read the
 * notice exactly as they read a news story, and "where did this come from" has the same answer.
 *
 * No model is called. TED returns the winner, the buyer, the value, the CPV codes and the dates as
 * fields, so there is nothing to extract and nothing to verify a model against; a field the notice
 * leaves empty stays empty and is shown as not stated.
 *
 * When the winner already has a lead for the same contract — its press release, or the same notice
 * republished — the notice is linked to that lead as a second source instead of making another.
 * The rule is src/lib/same-contract.ts.
 *
 * One timed pass. A run that reaches its deadline stops, records how far it got, and the next run
 * picks up: a notice already stored is skipped rather than read twice.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { classifyAndStoreLead, refreshCompanyIndustries } from '@/lib/industry-store';
import { searchTed, tedStats, AWARD_FIELDS, type TedRecord } from './ted';
import { AWARD_NOTICE_TYPES, TRADE_CPV, tradeCpvFor } from './cpv';
import { KIND_SECTOR, TRADE_BUYERS, tradeBuyerFor, type TradeBuyer } from './buyers';
import { normalizeAward, awardText, formatValue, type Award } from './award';
import { findOrCreateCompany } from '@/lib/find-or-create-company';
import { findSameContract, mergeSameContract, canonicalOf, type SourceRecord } from '@/lib/same-contract';
import { inferTrades } from '@/lib/trades';
import { regionFor } from '@/lib/geo';
import { fitScore } from '@/lib/fit';
import { appearsIn } from '@/lib/ai/claude';
import { logCost } from '@/lib/cost';
import { hasAwardDate } from '@/lib/schema-features';

/** The sources row the notices are filed under. Radar's HTML crawl of this page reads nothing. */
export const TED_SOURCE_URL = 'https://ted.europa.eu/';
const PAGE = 100;

const ymd = (d: string) => d.replace(/-/g, '');
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export type IngestOptions = {
  from: string;
  to: string;
  deadlineAt: number;
  /** Read and match, write nothing. Companies are looked up, never created. */
  dryRun?: boolean;
  /** Specific notices by publication number, instead of the date window. */
  notices?: string[];
  /** Only with dryRun and notices: see what a notice outside the trade list would have made. */
  ignoreCpv?: boolean;
  /** Only with notices: read a notice already stored again, for a winner the first pass could not use. */
  reprocess?: boolean;
};

export type LeadLine = {
  notice: string; company: string; companyCreated: boolean; matchedOn?: string;
  leadId: string | null; value: string | null; country: string | null;
  /** Set when the notice was linked to an existing lead for the same contract. */
  mergedInto?: string;
};

export type MergeLine = { notice: string; company: string; leadId: string; canonical: 'incoming' | 'existing'; why: string };

/**
 * Where the daily run starts: two days before the newest notice already stored, so a notice TED
 * indexed late is still caught, and never more than fourteen days back.
 */
export async function tedWindowFor(db: SupabaseClient): Promise<{ from: string; to: string }> {
  const to = isoDay(Date.now());
  const floor = isoDay(Date.now() - 14 * 86400000);
  const { data: src } = await db.from('sources').select('id').eq('url', TED_SOURCE_URL).maybeSingle();
  const { data: latest } = src
    ? await db.from('articles').select('published_at').eq('source_id', src.id).not('published_at', 'is', null)
      .order('published_at', { ascending: false }).limit(1).maybeSingle()
    : { data: null as any };
  const from = latest?.published_at
    ? isoDay(new Date(latest.published_at).getTime() - 2 * 86400000)
    : isoDay(Date.now() - 3 * 86400000);
  return { from: from < floor ? floor : from, to };
}

/**
 * Is this award ours? The whole rule, in one place so it can be tested without a database, a network
 * or a run — `scripts/tender-gate-check.ts` holds it to both arms.
 *
 * CPV-or-(buyer AND CPV division 45 or 50), measured before it was written (2026-09-20).
 *
 * The main classification decides, as it always has: a school build that lists a scaffolding lot
 * among twenty codes is a school build, its winners are tilers and landscapers, and the notice does
 * not say which winner took which lot.
 *
 * ...and a buyer whose work is always ours keeps an award the codes alone would drop — but only while
 * the MAIN classification still says the contract is WORK. The 42 trade codes keep about 1% of award
 * notices in every country, because a mixed contract gets filed under a generic parent: Denmark's 46
 * awards under the bare 45000000 held Ørsted Bioenergy & Thermal Power, Energinet Eltransmission
 * three times, a 60/10 kV substation and a pipeline relay, every one dropped.
 *
 * Both halves are load-bearing. The buyer alone is too loose — it rescues Energinet's group life
 * insurance (66522000), its helicopters (60424120) and its consultants (71000000), because a
 * buyer-only rule takes everything that buyer purchases; measured, 35 -> 121 awards of which most
 * were not work at all. Division 45 or 50 alone is far too loose the other way: the same generic
 * 45000000 carries Trondheim kommune's schools. Together: 35 -> 61 over 60 days across six
 * countries, and all twenty additions were read one by one.
 */
export function awardDecision(a: Pick<Award, 'mainCpv' | 'buyers'>) {
  const hits = tradeCpvFor(a.mainCpv);
  let buyerHit: TradeBuyer | undefined;
  for (const name of a.buyers) {
    const found = tradeBuyerFor(name);
    if (found) { buyerHit = found; break; }
  }
  // Reads a.mainCpv and nothing else, for the same reason the line above does.
  const mainIsWork = a.mainCpv.some((c) => /^(45|50)/.test(String(c)));
  // ONE verdict, not two overlapping booleans. An award can satisfy both halves, and an earlier
  // version returned `keptByBuyer: true` for it — true in the sense "the buyer rule would also keep
  // this", false in the sense every caller wanted. `by` says which rule actually decided, so a
  // counter cannot double-count and a sector cannot be taken from the wrong place.
  const by: 'cpv' | 'buyer' | null = hits.length ? 'cpv' : (buyerHit && mainIsWork) ? 'buyer' : null;
  return { hits, buyerHit, by, mainIsWork };
}

export async function ingestTedAwards(db: SupabaseClient, opts: IngestOptions) {
  if (opts.ignoreCpv && !(opts.dryRun && opts.notices?.length)) throw new Error('ignoreCpv is only allowed on a dry run of named notices');
  const started = Date.now();
  const before = { ...tedStats };

  const { data: src } = await db.from('sources').select('id, workspace_id').eq('url', TED_SOURCE_URL).maybeSingle();
  // No guessing a workspace: with probe workspaces coming and going, "the first one" can be a test.
  const workspaceId: string = src?.workspace_id ?? '';
  if (!workspaceId) throw new Error(`no workspace to file awards under: the ${TED_SOURCE_URL} sources row is missing or has none`);
  const { data: agencies } = await db.from('companies').select('name').eq('workspace_id', workspaceId).eq('employer_type', 'staffing_agency');
  const agencyNames = (agencies ?? []).map((a: any) => a.name as string);

  const report = {
    source: 'TED search API',
    window: opts.notices?.length ? { notices: opts.notices } : { from: opts.from, to: opts.to },
    dryRun: !!opts.dryRun,
    noticesInWindow: 0,
    noticesChecked: 0,
    alreadyStored: 0,
    outsideTradeCpv: 0,
    // Kept because the buyer is on the list and the main code is work, where the codes alone said no.
    keptByBuyer: 0,
    // How many notices each search returned, and how many answered both.
    byQuery: {} as Record<string, number>,
    seenInBothSearches: 0,
    noWinner: 0,
    awardsMatched: 0,
    bySector: {} as Record<string, number>,
    winners: 0,
    leadsCreated: 0,
    leadsAlreadyThere: 0,
    mergedIntoExisting: 0,
    ambiguousNotMerged: 0,
    companiesCreated: 0,
    companiesMatched: 0,
    companiesUnusable: 0,
    errors: 0,
    stoppedEarly: false,
    nextPage: null as number | null,
    requests: 0,
    throttled: 0,
    seconds: 0,
    eur: 0,
    merged: [] as MergeLine[],
    rejected: [] as { notice: string; why: string }[],
    leads: [] as LeadLine[],
  };
  const created = new Set<string>();
  const matched = new Set<string>();

  /**
   * TWO searches on the date-window path, because one cannot reach both halves of the rule.
   *
   * The CPV search is the original: notices carrying one of the 42 trade codes anywhere. It is also
   * a wall — an award filed under a generic parent like 45000000 carries none of them, so it is
   * never returned, never reaches `handle()`, and no gate written there could keep it. Measured on
   * 2026-09-20 over the same 60-day window: of 23 awards the buyer rule should keep, that search
   * returns 3, and the three it does return only pass because they happen to carry a trade code as
   * an ADDITIONAL classification. Widening it is not an option — this query has no country filter,
   * so dropping the CPV clause pulls the whole European award feed into a 300 s budget.
   *
   * So the allowlisted buyers get their own narrow search. `buyer-name~"…"` was confirmed against
   * the live API on 2026-09-21: whole-word, diacritic-folding, and `LIKE` rejected outright. All 18
   * terms in one OR is 497 characters and TED accepts it; over 60 days it returns 156 notices, and
   * over a 3-day daily window, one.
   *
   * The search deliberately over-fetches and `tradeBuyerFor` decides: the term for Kredsløb also
   * returns Kredsløb A/S, and the term for Jönköping Energi also returns Hälsohögskolan i Jönköping,
   * both of which the gate then rejects. A net, and a filter — fetching a few extra notices costs
   * nothing, keeping them would be the bug.
   */
  const windowClauses = [
    `notice-type IN (${AWARD_NOTICE_TYPES.join(' ')})`,
    `publication-date>=${ymd(opts.from)}`,
    `publication-date<=${ymd(opts.to)}`,
  ];
  const buyerTerms = TRADE_BUYERS.map((b) => `buyer-name~"${b.search ?? b.match}"`).join(' OR ');
  const queries: { why: string; q: string }[] = opts.notices?.length
    ? [{ why: 'named notices', q: `publication-number IN (${opts.notices.join(' ')})` }]
    : [
      { why: 'trade CPV codes', q: [...windowClauses, `classification-cpv IN (${TRADE_CPV.map((e) => e.code).join(' ')})`].join(' AND ') },
      { why: 'allowlisted buyers', q: [...windowClauses, `(${buyerTerms})`].join(' AND ') },
    ];

  const { data: runRow } = opts.dryRun
    ? { data: null }
    : await db.from('radar_runs').insert({ workspace_id: workspaceId, tier: 'tenders:ted', cursor: 0, batch: PAGE }).select('id').maybeSingle();

  async function handle(record: TedRecord) {
    const a = normalizeAward(record);
    const reject = (why: string) => report.rejected.push({ notice: a.noticeId, why });
    // The procedure's main classification decides. A school build that lists a scaffolding lot
    // among twenty codes is a school build: its winners are tilers and landscapers, and the
    // notice does not say which winner took which lot.
    const { hits, buyerHit, by } = awardDecision(a);

    if (by === null && !opts.ignoreCpv) {
      report.outsideTradeCpv++;
      const additional = tradeCpvFor(a.cpv).map((h) => h.code);
      reject(buyerHit
        ? `${buyerHit.label} is on the buyer list, but the main classification ${a.mainCpv.join(', ') || 'not stated'} is neither construction (45) nor repair (50)`
        : additional.length
          ? `main classification ${a.mainCpv.join(', ') || 'not stated'} is not trade work; trade codes only as additional classifications (${additional.join(', ')})`
          : `no CPV code on the notice is in the trade list (main ${a.mainCpv.join(', ') || 'not stated'})`);
      return;
    }
    if (by === 'buyer') report.keptByBuyer++;

    const { data: stored } = await db.from('articles').select('id').eq('url', a.url).maybeSingle();
    if (stored && !opts.dryRun && !opts.reprocess) { report.alreadyStored++; return; }

    const fetchedAt = new Date().toISOString();
    const text = awardText(a, record, fetchedAt);
    // Re-reading a stored notice keeps its article: the leads it already made are found by URL
    // below, so only a winner that was missed the first time gets a lead now.
    let articleId: string | null = stored && opts.reprocess ? stored.id : null;
    if (!opts.dryRun && !articleId) {
      const { data: art, error } = await db.from('articles').insert({
        source_id: src?.id ?? null, url: a.url, title: a.title, text,
        published_at: a.publishedOn || null, last_fetch_status: 'live', last_fetch_at: fetchedAt,
        // 0024: the award's own date, which ages the lead (src/lib/lead-age.ts). Until the column
        // exists it stays in the text only, and the lead is aged from the notice's publication.
        ...(a.awardDate && (await hasAwardDate(db)) ? { award_date: a.awardDate.date, award_date_basis: a.awardDate.which } : {}),
      }).select('id').single();
      if (error) throw new Error(`could not store the notice: ${error.code} ${error.message}`);
      articleId = art.id;
    }

    // Stored either way — it was read — but a notice that names no winner has no company to call.
    if (!a.winners.length) { report.noWinner++; reject('the notice names no winning company'); return; }
    report.awardsMatched++;
    // A buyer-kept award has no CPV hit to take a sector from, so it takes the buyer's own kind
    // (KIND_SECTOR) — otherwise the lead would be filed under nothing at all.
    const sectors = by === 'cpv'
      ? new Set(hits.map((h) => h.sector))
      : new Set(buyerHit ? [KIND_SECTOR[buyerHit.kind]] : []);
    for (const sector of sectors) report.bySector[sector] = (report.bySector[sector] ?? 0) + 1;

    // Trades from what the CPV codes describe, plus any the title and scope spell out.
    const { trades } = inferTrades(hits.flatMap((h) => h.trades), a.title, a.description);
    const asSource = (url: string): SourceRecord => ({
      kind: 'tender', url, date: a.publishedOn, dateKnown: /^\d{4}-\d{2}-\d{2}$/.test(a.publishedOn), text, buyers: a.buyers, title: a.title || null,
    });

    for (const [i, name] of a.winners.entries()) {
      report.winners++;
      if (!appearsIn(text, name)) throw new Error(`winner "${name}" is not in the stored notice text`);
      const hit = await findOrCreateCompany(db, {
        workspaceId, name, domain: a.winnerDomain, source: 'ted award notice', sourceUrl: a.url, agencyNames, dryRun: opts.dryRun,
      });
      if (!hit) { report.companiesUnusable++; reject(`winner "${name}" is not a usable company name`); continue; }
      (hit.created ? created : matched).add(hit.id);

      // One lead per winner. A framework split three ways is three companies that won work, and
      // leads.source_url is unique, so each winner's lead points at the notice under its own anchor.
      const leadUrl = a.winners.length > 1 ? `${a.url}#winner-${i + 1}` : a.url;
      const line: LeadLine = { notice: a.noticeId, company: hit.name, companyCreated: hit.created, matchedOn: hit.matchedOn, leadId: null, value: formatValue(a.value), country: a.country };
      report.leads.push(line);
      const incoming = asSource(leadUrl);

      if (opts.dryRun) {
        // Read-only: would this have been linked to a lead the company already has?
        if (!hit.created) {
          const same = await findSameContract(db, { workspaceId, companyId: hit.id, incoming });
          if (same.match) {
            const decision = canonicalOf(same.existing, incoming);
            report.merged.push({ notice: a.noticeId, company: hit.name, leadId: same.leadId, canonical: decision.canonical, why: `${same.why}; ${decision.why}` });
            line.mergedInto = same.leadId;
          } else if (same.ambiguous.length) {
            report.ambiguousNotMerged++;
            reject(`"${name}": ${same.why}`);
          }
        }
        continue;
      }

      const { data: existing } = await db.from('leads').select('id').eq('source_url', leadUrl).maybeSingle();
      if (existing) {
        report.leadsAlreadyThere++;
        line.leadId = existing.id;
        await db.from('lead_articles').upsert({ lead_id: existing.id, article_id: articleId });
        continue;
      }

      // A company made a moment ago has no leads to be the same contract as.
      if (!hit.created) {
        const same = await findSameContract(db, { workspaceId, companyId: hit.id, incoming });
        if (same.match) {
          const merged = await mergeSameContract(db, same, incoming, articleId!, { project_value: formatValue(a.value), country: a.country, region: regionFor(a.country) });
          report.mergedIntoExisting++;
          report.merged.push({ notice: a.noticeId, company: hit.name, leadId: same.leadId, canonical: merged.canonical, why: merged.why });
          line.leadId = same.leadId;
          line.mergedInto = same.leadId;
          continue;
        }
        if (same.ambiguous.length) {
          report.ambiguousNotMerged++;
          reject(`"${name}": ${same.why} — a lead of its own was made`);
        }
      }

      const { data: co } = await db.from('companies').select('employer_type').eq('id', hit.id).maybeSingle();
      const { data: lead, error } = await db.from('leads').insert({
        workspace_id: workspaceId,
        company_id: hit.id,
        kind: 'won_work',
        project_name: a.title || null,
        project_location: [a.city, a.countriesRaw.join(', ')].filter(Boolean).join(', ') || null,
        project_value: formatValue(a.value),
        trades_inferred: trades,
        country: a.country,
        region: regionFor(a.country),
        fit_score: fitScore(trades, a.country, co?.employer_type ?? 'unknown', null),
        source_url: leadUrl,
        source_fetched_at: fetchedAt,
      }).select('id').single();
      if (error) throw new Error(`could not create the lead for "${name}": ${error.code} ${error.message}`);
      line.leadId = lead.id;
      report.leadsCreated++;
      const { error: linkError } = await db.from('lead_articles').upsert({ lead_id: lead.id, article_id: articleId });
      if (linkError) throw new Error(`could not link the notice to the lead for "${name}": ${linkError.code} ${linkError.message}`);
      // Item 18: industries from the notice's CPV codes. A failure is reported with the run, and the lead stands.
      for (const problem of [await classifyAndStoreLead(db, lead.id), await refreshCompanyIndustries(db, hit.id)]) if (problem) reject(`"${name}": ${problem}`);
    }
  }

  let failure: string | null = null;
  try {
    // A notice can answer both searches — an award whose buyer is on the list and which also carries
    // a trade code. Deduped here rather than left to `handle()`: it would be caught there by the
    // already-stored check, but only after a database round trip, and it would count as
    // `alreadyStored` when it is nothing of the kind.
    const seenNotices = new Set<string>();
    for (const { why, q } of queries) {
      if (report.stoppedEarly) break;
      for (let page = 1; ; page++) {
        if (Date.now() > opts.deadlineAt) { report.stoppedEarly = true; report.nextPage = page; break; }
        const res = await searchTed({ query: q, fields: AWARD_FIELDS, limit: PAGE, page });
        report.noticesInWindow += res.totalNoticeCount;
        report.byQuery[why] = (report.byQuery[why] ?? 0) + res.notices.length;
        for (const record of res.notices) {
          if (Date.now() > opts.deadlineAt) { report.stoppedEarly = true; report.nextPage = page; break; }
          const number = String(record['publication-number']);
          if (seenNotices.has(number)) { report.seenInBothSearches++; continue; }
          seenNotices.add(number);
          report.noticesChecked++;
          try {
            await handle(record);
          } catch (e: any) {
            // One notice that will not store must not cost the rest of the day's awards.
            report.errors++;
            report.rejected.push({ notice: number, why: `error: ${String(e?.message ?? e).slice(0, 300)}` });
          }
        }
        if (report.stoppedEarly || res.notices.length < PAGE || page * PAGE >= res.totalNoticeCount) break;
      }
    }
  } catch (e: any) {
    failure = String(e?.message ?? e).slice(0, 500);
    throw e;
  } finally {
    report.companiesCreated = created.size;
    report.companiesMatched = matched.size;
    report.requests = tedStats.requests - before.requests;
    report.throttled = tedStats.throttled - before.throttled;
    report.seconds = Math.round((Date.now() - started) / 1000);
    if (!opts.dryRun) {
      const { rejected, leads, ...tally } = report;
      if (runRow) {
        await db.from('radar_runs').update({
          finished_at: new Date().toISOString(), tally, rejected: rejected.slice(0, 500), error: failure,
          sources_seen: [{ source: report.source, via: 'api', links: report.noticesChecked, note: JSON.stringify(report.window) }],
        }).eq('id', runRow.id);
      }
      // Recorded even at zero, so a day's spend can be read back rather than assumed.
      await logCost(db, workspaceId, 'fetch', `TED search API · ${report.requests} requests · ${report.noticesChecked} notices`, report.requests, 0);
    }
  }
  return report;
}

export type IngestReport = Awaited<ReturnType<typeof ingestTedAwards>>;
