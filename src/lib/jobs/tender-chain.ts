import type { SupabaseClient } from '@supabase/supabase-js';
import { Budget, DAILY_BUDGET_EUR, spentEur } from '@/lib/cost';
import { crawlWorkspace } from '@/lib/crawl-workspace';
import { lookupDomain } from '@/lib/domain-lookup';
import { addressCheck, checkedAddress } from '@/lib/address-check';
import { fetchNoticeXml, publicationNumber, winnerAddress, ISO3_TO_2 } from '@/lib/tender/winner-address';
import { leadSource, primaryArticle } from '@/lib/lead-source';
import { siteScope, mayStoreDomain } from '@/lib/site-scope';
import { nonProspect } from '@/lib/prospect-scope';
import { CLOSED_LEAD_STATUSES, LEAD_STATE_EMBED, LEAD_STATE_TABLE } from '@/lib/workspace-state';
import { tenderLeadAge } from '@/lib/lead-age';
import { articlesByLead } from '@/lib/lead-articles';
import { hasAwardDate, hasDomainProvenance } from '@/lib/schema-features';
import { AGE_UNKNOWN, discoveryOrder } from '@/lib/discovery-order';
import { discoverAtCompany } from '@/lib/company-contact-discovery';

/**
 * THE TENDER CHAIN (owner's approval 2026-10-12): every TED winner with no website, in every country, newest first,
 * gets ONE web lookup a day (at most two in its life), the free address check, every existing guard, and — when a
 * domain is stored — contact discovery straight away. The careers check and the "Currently hiring" tag are NOT
 * re-implemented: the tick's `discovery` unit already takes any company that gains a domain
 * (`careers_checked_at is null`), and the `job-posts` crawl decides whether it has an open posting.
 *
 * It is the path scripts/resolve-wonwork-domains.ts has run by hand since 2026-09-15, moved behind four controls:
 *
 *   KILL SWITCH   job_switches.tender-chain (0062), flipped in SQL with no deploy. Missing table, missing row or
 *                 an unreadable one all read OFF. The tick never runs it while off; a named --ids run by hand
 *                 (the HOLBØLL proof) is the only path that does, because the owner asked for it explicitly.
 *   THE CLOCK     "today" is db_utc_today() — the same expression cost_log.day is stamped with — never this
 *                 process's clock, which has read hours stale on this machine before.
 *   THE SLICE     EUR 1.00 a day for this chain (SLICE_EUR), counted from cost_log rows whose detail carries
 *                 LABEL, INSIDE the system-wide EUR 2.00 cap, which is checked too. Both before every lookup.
 *   THE LOG       the tick records each batch's summary in job_ticks; cost_log holds only real spend.
 *
 * Guards kept, every one of them, by calling the same functions the script calls: address verification
 * (addressCheck, stored as domain_address_check — "not printed" is stored and labelled unconfirmed, never
 * hidden), brand and shared-domain verification (mayStoreDomain, with the group-site rule and either-spelling
 * names), the directory and trade-body refusals (looksLikeDirectory inside mayStoreDomain; nonProspect on the
 * queue), a refusal counted as an attempt and never stored, the model's own "answer null when not clearly
 * identifiable", and `.is('domain', null)` on the write so a domain somebody else stored is never overwritten.
 * Municipal ranking is untouched: this changes no score and no order on any screen. No name is inferred anywhere.
 */

export const LABEL = 'tender-chain';
export const SLICE_EUR = Math.min(1.0, DAILY_BUDGET_EUR);
export const MAX_LOOKUPS = 2;
/**
 * TOO OLD TO BUY (owner's decision 2026-10-12): an award older than item 17's stale line for tenders is not looked
 * up. The dry run found 98 of 113 queued winners were Czech electrical framework participants whose awards date
 * from 2020 (2,327 days), republished on TED in 2026. COMPUTED, NEVER WRITTEN: the skip is a verdict on the queue,
 * not a status on the company, so nothing is ever recorded as "no website" and reopening one is changing this
 * number. An award with NO date is not "too old" — unknown is not old — and stays in the queue.
 */
export const MAX_AWARD_AGE_DAYS = 365;

/**
 * HELD FOR THE OWNER — A PLAIN RULE, NOT A LIST (owner's decision 2026-10-12, replacing a nine-name list the same day).
 * A name is held out of the paid queue when it carries NO COMPANY FORM (GmbH, s.r.o., A/S, Sp. z o.o. …) and NO
 * TRADE WORD (Gerüstbau, Elektro, Metallbau, montáže …): that is what a sole trader named as a person looks like —
 * "Aleš Kozel", "Ing. Martin Barteček". The first cut was a guess of mine that also caught Bassenberg Gerüstbau, a
 * scaffolding FIRM; the trade-word arm is what releases it. Every held name is listed in the dry run for the owner.
 * Checked AFTER the age limit, so a too-old award reports "too old" (the eight Czech sole traders, 2,327 days).
 */
const COMPANY_FORM = /(^|[\s,.(])(gmbh|ag|kg|ohg|gbr|ug|se|e\.?\s?k\.?|s\.?\s?r\.?\s?o\.?|a\.?\s?s\.?|spol\.?|sp\.?\s?z\s?o\.?\s?o\.?|sp\.?\s?j\.?|s\.?\s?a\.?|a\/s|aps|as|asa|ab|oy|oyj|ltd|limited|plc|llc|inc|bv|b\.v\.|nv|n\.v\.|vof|srl|s\.?r\.?l\.?|spa|s\.?p\.?a\.?|snc|sas|sarl|sl|kft|zrt|bt|d\.?\s?o\.?\s?o\.?|d\.?\s?d\.?|oü|ou|uab|sia|eood|ood|ead|еоод|оод|ад|ехф|ehf|hf|co|company|group|gruppe|holding|sau|s\.?\s?l\.?u?|lda|s\.?\s?c\.?|aktiebolag|aksjeselskap|aktieselskab|osakeyhtiö|társaság|tarsasag|részvénytársaság|reszvenytarsasag|sabiedrība|sabiedriba|spółka|spolka|společnost|spolecnost|gembh)(?=$|[\s,.)"”\-])/i;
const TRADE_WORD = /(bau|elektr|electr|montaz|montáž|metall|metal|stahl|gerust|gerüst|geruest|service|servis|technik|techni|install|impiant|energ|werft|marine|offshore|construct|konstruk|engineer|rohr|kabel|maler|isolier|schweiss|kran|anlagen|industri|wind|build|stroj|stav|elmont|transport|logist|consult|wiert|zaklad|zakład|uslug|usług|firma|werk|works|systems|solutions|gerät|tiefbau|hochbau|haustechnik|instal|vvs|smed|byg|entrepren|maskin|rør|brodograd|stocznia|astiller|shipyard|yard|wegenbouw|echafaud|échafaud|linij|linie|grid|power|infra|technolog|repair|plovidba|ditta|invest|commerce|épít|epit)/i;
export function soleTraderName(name: string): boolean {
  const n = String(name ?? '').trim();
  if (!n) return false;
  return !COMPANY_FORM.test(n) && !TRADE_WORD.test(n);
}

/**
 * Why a company is NOT in today's paid queue, or null when it is. Pure, so tender-chain-check holds every arm.
 * Precedence: a non-prospect, then age, then the owner's hold, then "already today".
 */
export function skipReason(t: { id: string; name: string; age: number; lookedToday: boolean }): string | null {
  const np = nonProspect(t.name);
  if (np) return `not a prospect: ${np.category} ("${np.term}")`;
  if (t.age !== AGE_UNKNOWN && t.age > MAX_AWARD_AGE_DAYS) return `skipped: too old (award ${t.age} days old, limit ${MAX_AWARD_AGE_DAYS})`;
  if (soleTraderName(t.name)) return "held: no company form and no trade word — reads like a sole trader; owner's decision pending";
  if (t.lookedToday) return 'already looked up today — its retry is a later day';
  return null;
}

/** What one lookup may cost before it is started: measured €0.023-0.034 a company, so €0.05 leaves margin. */
export const LOOKUP_ESTIMATE_EUR = 0.05;

export type ChainSwitch = { enabled: boolean; why: string };

/** The kill switch. Anything other than a readable row saying enabled = true is OFF. */
export async function chainSwitch(db: SupabaseClient): Promise<ChainSwitch> {
  const { data, error } = await db.from('job_switches').select('enabled, note, updated_at').eq('name', LABEL).maybeSingle();
  if (error) return { enabled: false, why: `the switch could not be read (${error.message}) — off until it can` };
  if (!data) return { enabled: false, why: 'no tender-chain switch row — 0062 not applied — off' };
  return data.enabled === true
    ? { enabled: true, why: `on since ${data.updated_at}${data.note ? ` (${data.note})` : ''}` }
    : { enabled: false, why: `switched off${data.note ? `: ${data.note}` : ''}` };
}

/** Today's UTC date by the DATABASE's clock. Throws rather than guessing: a cap with the wrong day is no cap. */
export async function dbToday(db: SupabaseClient): Promise<string> {
  const { data, error } = await db.rpc('db_utc_today');
  if (error || typeof data !== 'string') throw new Error(`the database clock could not be read (${error?.message ?? 'no answer'}) — is 0062 applied?`);
  return data.slice(0, 10);
}

/** This chain's spend on `day`: cost_log rows whose detail names LABEL (lookupDomain's "resolve …" and "web search · …"). */
export async function sliceSpent(db: SupabaseClient, day: string): Promise<number> {
  let total = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('cost_log').select('eur').eq('day', day).like('detail', `%${LABEL} · %`).order('id').range(from, from + 999);
    if (error) throw new Error(`the chain's spend could not be read: ${error.message}`);
    total += (data ?? []).reduce((s: number, r: any) => s + Number(r.eur ?? 0), 0);
    if (!data || data.length < 1000) return total;
  }
}

export type Queued = { id: string; name: string; notice: string | null; leadCountry: string | null; lookups: number; age: number; lookedToday: boolean; skipped?: string };

/**
 * Every tender winner the chain may look up, in the order it will: freshest award first (item 17's age, never
 * when WE stored the row), a retry before a first look inside the same age bucket, then the name. Tender-sourced
 * open won-work leads only; news leads stay with the script. Non-prospects are listed with their reason, not hidden.
 */
export async function tenderQueue(db: SupabaseClient, today: string): Promise<{ queue: Queued[]; skipped: Queued[]; finalMisses: number }> {
  const workspaceId = await crawlWorkspace(db);
  const provenance = await hasDomainProvenance(db);
  if (!provenance) throw new Error('0033 (domain provenance) is not applied: the chain cannot record what it found');
  const leads: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('leads')
      .select(`id, source_url, country, companies!inner(id, name, domain, careers_status, domain_lookups, domain_looked_up_at), ${LEAD_STATE_EMBED}`)
      .eq('workspace_id', workspaceId).eq('kind', 'won_work').eq('is_test', false)
      .not(`${LEAD_STATE_TABLE}.status`, 'in', CLOSED_LEAD_STATUSES).is('companies.domain', null)
      .order('id').range(from, from + 999);
    if (error) throw new Error(`the tender queue could not be read: ${error.message}`);
    leads.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const tender = leads.filter((l) => leadSource(l.source_url) === 'tender');
  const awardCols = (await hasAwardDate(db)) ? ', award_date, award_date_basis' : '';
  const { byLead, error } = await articlesByLead(tender.map((l) => l.id), awardCols);
  if (error) throw new Error(`the award dates behind the queue could not be read: ${error}`);
  const todo = new Map<string, Queued & { final: boolean }>();
  for (const l of tender) {
    const c = l.companies;
    const art: any = primaryArticle(byLead.get(l.id) ?? [], l.source_url);
    const age = tenderLeadAge({ awardDate: art?.award_date, awardBasis: art?.award_date_basis, publishedAt: art?.published_at, awardDateRead: !!awardCols }).days ?? AGE_UNKNOWN;
    const t = todo.get(c.id) ?? {
      id: c.id, name: c.name, notice: publicationNumber(l.source_url), leadCountry: l.country ?? null,
      lookups: Number(c.domain_lookups ?? 0), age: AGE_UNKNOWN, final: c.careers_status === 'no_domain_found',
      // ONE LOOKUP PER COMPANY PER DAY, by the database's day: a retry is a different day's answer, never the same search twice.
      lookedToday: String(c.domain_looked_up_at ?? '').slice(0, 10) === today,
    };
    t.age = Math.min(t.age, age);
    t.notice ??= publicationNumber(l.source_url);
    todo.set(c.id, t);
  }
  const all = [...todo.values()];
  const skipped: Queued[] = [];
  const queue: Queued[] = [];
  for (const t of all) {
    if (t.final || t.lookups >= MAX_LOOKUPS) continue;
    const why = skipReason(t);
    if (why) { skipped.push({ ...t, skipped: why }); continue; }
    queue.push(t);
  }
  return { queue: queue.sort(discoveryOrder), skipped, finalMisses: all.filter((t) => t.final).length };
}

export type CompanyOutcome = {
  name: string; country: string | null; registrationId: string | null; query: 'full address' | 'town only' | 'no place';
  result: 'stored' | 'group site stored' | 'refused' | 'no website' | 'error'; domain?: string | null; addressCheck?: string; checked?: string | null;
  confirmedBy?: string | null; sourceUrl?: string | null; reason?: string | null; eur: number; final?: boolean; contacts?: Record<string, unknown>;
};

export type ChainRun = {
  day: string; switch: ChainSwitch; queue: number; looked: number; stored: number; group: number; refused: number; missed: number;
  final: number; errors: number; contactsGained: number; eur: number; sliceSpent: number; capSpent: number; stopped: string;
  capped: boolean; outcomes: CompanyOutcome[];
};

/**
 * One batch. `ids` names companies to run regardless of the switch (the owner's explicit, by-hand proof run); without
 * it the switch must be on. `write: false` looks nothing up and spends nothing — it is the dry run.
 */
export async function runTenderChain(db: SupabaseClient, o: { batch: number; write: boolean; ids?: string[]; deadlineAt?: number }): Promise<ChainRun> {
  const day = await dbToday(db);
  const sw = await chainSwitch(db);
  const base = { day, switch: sw, looked: 0, stored: 0, group: 0, refused: 0, missed: 0, final: 0, errors: 0, contactsGained: 0, eur: 0, outcomes: [] as CompanyOutcome[] };
  const sliceBefore = await sliceSpent(db, day);
  const capBefore = await spentEur(db, { day });
  if (!o.ids?.length && !sw.enabled) {
    return { ...base, queue: 0, sliceSpent: sliceBefore, capSpent: capBefore, stopped: `kill switch: ${sw.why}`, capped: false };
  }
  const { queue } = await tenderQueue(db, day);
  const picked = o.ids?.length ? queue.filter((t) => o.ids!.includes(t.id)) : queue;
  const run: ChainRun = { ...base, queue: picked.length, sliceSpent: sliceBefore, capSpent: capBefore, stopped: '', capped: false };
  if (!o.write) { run.stopped = 'dry run — nothing looked up, nothing spent'; return run; }

  const workspaceId = await crawlWorkspace(db);
  // The cap's Budget on the DATABASE's day: Budget.open would read "today" from this process's clock.
  const budget = new Budget(capBefore, DAILY_BUDGET_EUR);
  const deadlineAt = o.deadlineAt ?? Date.now() + 240_000;
  for (const t of picked.slice(0, Math.max(1, o.batch))) {
    if (Date.now() > deadlineAt) { run.stopped = 'time used; the next batch continues'; break; }
    if (sliceBefore + run.eur + LOOKUP_ESTIMATE_EUR > SLICE_EUR) { run.stopped = `the tender slice is spent (€${(sliceBefore + run.eur).toFixed(4)} of €${SLICE_EUR.toFixed(2)} today)`; run.capped = true; break; }
    if (!budget.canAfford(LOOKUP_ESTIMATE_EUR)) { run.stopped = `the daily cap is spent (€${budget.totalToday.toFixed(4)} of €${budget.capEur.toFixed(2)})`; run.capped = true; break; }
    run.looked++;
    const out = await oneCompany(db, t, { day, workspaceId, budget, deadlineAt });
    run.eur += out.eur;
    run.outcomes.push(out);
    if (out.result === 'stored' || out.result === 'group site stored') run.stored++;
    if (out.result === 'group site stored') run.group++;
    if (out.result === 'refused') run.refused++;
    if (out.result === 'no website') run.missed++;
    if (out.result === 'error') run.errors++;
    if (out.final) run.final++;
    if (out.contacts && (out.contacts.switchboard || out.contacts.general)) run.contactsGained++;
  }
  run.sliceSpent = sliceBefore + run.eur;
  run.capSpent = budget.totalToday;
  run.stopped ||= picked.length > run.looked ? `batch of ${o.batch} done; ${picked.length - run.looked} left in the queue` : 'queue empty';
  return run;
}

async function oneCompany(db: SupabaseClient, t: Queued, ctx: { day: string; workspaceId: string; budget: Budget; deadlineAt: number }): Promise<CompanyOutcome> {
  const xml = t.notice ? await fetchNoticeXml(t.notice) : null;
  const a = xml ? winnerAddress(xml, t.name) : null;
  const country = (a?.country ? ISO3_TO_2[a.country] ?? a.country : null) ?? t.leadCountry;
  const registrationId = a?.companyId?.trim() || null;
  const query = a?.street && (a.city || a.postalCode) ? 'full address' : a && (a.city || a.postalCode) ? 'town only' : 'no place';
  const attempt = t.lookups + 1;
  const out: CompanyOutcome = { name: t.name, country, registrationId, query, result: 'error', eur: 0 };
  try {
    // A stamp is written on EVERY outcome that spent money, so the same search is never paid for twice in a day.
    const r = await lookupDomain({ name: t.name, country, address: a, registrationId }, { db, workspaceId: ctx.workspaceId, budget: ctx.budget, label: `${LABEL} · ${t.name}` });
    out.eur = r.eur; out.confirmedBy = r.confirmedBy; out.sourceUrl = r.sourceUrl;
    const stamp = { domain_lookups: attempt, domain_looked_up_at: new Date().toISOString() };
    if (!r.domain) {
      out.result = 'no website'; out.final = attempt >= MAX_LOOKUPS;
      await mustWrite(db.from('companies').update({ ...stamp, ...(out.final ? { careers_status: 'no_domain_found' } : {}) }).eq('id', t.id), `stamp ${t.name}`);
      return out;
    }
    out.domain = r.domain;
    const { data: holders, error: holdersErr } = await db.from('companies').select('name').eq('domain', r.domain).neq('id', t.id).limit(5);
    // An unreadable holder list must never read as "nobody else holds it", the permissive answer. Not stamped:
    // nothing was decided, and the next batch asks again.
    if (holdersErr) { out.result = 'error'; out.reason = `holders of ${r.domain} unreadable: ${holdersErr.message}`; return out; }
    const allowed = mayStoreDomain(t.name, r.domain, (holders ?? []).map((h: any) => h.name));
    if (!allowed.ok) {
      out.result = 'refused'; out.reason = allowed.reason; out.final = attempt >= MAX_LOOKUPS;
      await mustWrite(db.from('companies').update({ ...stamp, ...(out.final ? { careers_status: 'no_domain_found' } : {}) }).eq('id', t.id), `stamp ${t.name}`);
      return out;
    }
    const check = await addressCheck(r.domain, a);
    const checked = checkedAddress(a);
    out.addressCheck = check; out.checked = checked;
    const scope = allowed.group ? { scope: 'group' as const, reason: allowed.reason }
      : siteScope({ companyName: t.name, domain: r.domain, winnerCountry: country, sharedWith: (holders ?? []).map((h: any) => h.name) });
    const { data: written, error: upErr } = await db.from('companies').update({
      domain: r.domain, domain_source: 'web search', domain_source_url: r.sourceUrl ?? null,
      domain_address_check: check, domain_checked_address: checked, domain_scope: scope.scope, domain_scope_reason: scope.reason, ...stamp,
    }).eq('id', t.id).is('domain', null).select('id, name, domain, careers_url, contact_page_url, switchboard, general_email, workspace_id');
    if (upErr) { out.result = 'error'; out.reason = `not stored: ${upErr.message}`; return out; }
    if (!written?.length) { out.result = 'error'; out.reason = 'not stored: the company gained a domain from elsewhere meanwhile'; return out; }
    out.result = scope.scope === 'group' ? 'group site stored' : 'stored';
    out.reason = scope.reason;
    // CONTACT DISCOVERY, at once: page reads are free; the organisation-page read is the one model call and asks
    // the same cap Budget first. Fill-a-blank only, as everywhere: nothing already on file is overwritten.
    const co: any = written[0];
    out.contacts = await discoverAtCompany(db, co, { budget: ctx.budget, workspaceId: ctx.workspaceId, deadlineAt: ctx.deadlineAt }).catch((e: any) => ({ error: String(e?.message ?? e).slice(0, 160) }));
    return out;
  } catch (e: any) {
    // A lookup that THREW was not answered: not counted as an attempt, so a transport failure costs no retry.
    out.result = 'error'; out.reason = String(e?.message ?? e).slice(0, 200);
    return out;
  }
}

async function mustWrite(q: PromiseLike<{ error: { message: string } | null }>, what: string) {
  const { error } = await q;
  if (error) throw new Error(`${what}: ${error.message}`);
}
