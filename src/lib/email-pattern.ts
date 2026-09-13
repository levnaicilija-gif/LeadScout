/**
 * Queue item 14 (3): the shape of a company's email addresses, read off pages already fetched.
 *
 * Regex only, no model. An address counts toward a company's pattern only when it is on that
 * company's own domain; a press or media address still counts, because the shape of
 * "firstname.lastname@" does not change with the department. Nothing here is ever an address to
 * send to: a pattern is stored as a named shape with how often it was seen and on which pages, and
 * /api/outreach already refuses a pattern address.
 *
 * Stored article text runs words together where the page had line breaks, so an address is often
 * glued to its neighbours — "treasurerkevin.leader@mcdermott.com", "rreid@mcdermott.commedia".
 * A glued prefix is recovered only when a name printed beside the address reproduces the rest
 * exactly; a glued domain only when the company's own domain is a clean prefix of it. Anything
 * else — a typo domain ("vatttenfall.com"), leading digits, an address on a fraud-warning page —
 * is left out rather than guessed at.
 */
import { canonCompany, canonDomain } from './company-identity';

export type Pattern = 'first.last' | 'f.last' | 'flast' | 'firstlast' | 'first_last' | 'first-last' | 'first' | 'last.first' | 'firstl' | 'role';
export type Observation = { domain: string; pattern: Pattern; corroborated: boolean; address: string; name: string | null; url: string; readAt: string; note?: string };

const ROLE = /^(press|media|info|contact|communications?|comms|news|newsroom|pr|enquiries|inquiries|investor|investors|ir|hr|careers|jobs|recruitment|sales|office|post|mail|support|service|admin|webmaster|reception|marketing|procurement|purchasing)$/i;
const FRAUD = /\b(fraud|phishing|scam|suspicious|fraudulent|impersonat\w+)\b/i;

/** How a name is written in an address: ø → o and oe, ä → a and ae, and so on — both are used. */
function spellings(word: string): string[] {
  const w = word.toLowerCase();
  const out = new Set<string>();
  const a = w.replace(/[øö]/g, 'o').replace(/[äæ]/g, 'a').replace(/å/g, 'a').replace(/ü/g, 'u').replace(/ß/g, 'ss');
  const b = w.replace(/[øö]/g, 'oe').replace(/[äæ]/g, 'ae').replace(/å/g, 'aa').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  for (const x of [a, b]) out.add(x.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z-]/g, ''));
  return [...out].filter(Boolean);
}

/** Every address form a person's name could take, with the pattern it would be. */
function forms(name: string): { local: string; pattern: Pattern }[] {
  const parts = name.trim().split(/\s+/).filter((p) => /\p{L}/u.test(p));
  if (parts.length < 2) return [];
  const out: { local: string; pattern: Pattern }[] = [];
  for (const f of spellings(parts[0])) for (const l of spellings(parts[parts.length - 1])) {
    out.push(
      { local: `${f}.${l}`, pattern: 'first.last' }, { local: `${f[0]}.${l}`, pattern: 'f.last' }, { local: `${f[0]}${l}`, pattern: 'flast' },
      { local: `${f}${l}`, pattern: 'firstlast' }, { local: `${f}_${l}`, pattern: 'first_last' }, { local: `${f}-${l}`, pattern: 'first-last' },
      { local: `${l}.${f}`, pattern: 'last.first' },
    );
    // A first name alone ("dredging@", "kevin@") or a first name plus an initial is too short to
    // belong to one person: any capitalised word beside it would "corroborate" it. Not offered.
  }
  return out;
}

/** Capitalised two-to-four word runs just before an address: the people it could belong to. */
function namesBefore(text: string, index: number): string[] {
  const window = text.slice(Math.max(0, index - 160), index);
  const out: string[] = [];
  // A capitalised run can carry a title or a label in front of the name — "Treasurer Kevin Leader",
  // "Media Contact Reba Reid" — so every two-to-four word stretch inside it is a candidate, the
  // ones nearest the address first. No word boundary is required in front: stored text glues a
  // name to the label before it ("Global Media RelationsReba Reid"), and \b would skip "Reba".
  for (const m of window.matchAll(/[\p{Lu}][\p{Ll}'’-]+(?:\s+[\p{Lu}][\p{Ll}'’-]+)+/gu)) {
    const words = m[0].split(/\s+/);
    for (let len = Math.min(4, words.length); len >= 2; len--) {
      for (let start = words.length - len; start >= 0; start--) out.push(words.slice(start, start + len).join(' '));
    }
  }
  return out.reverse();
}

/** The address's domain, trimmed back to the company's own when text glued a word onto it. */
function ownDomain(emailDomain: string, company: { name: string; domain?: string | null }): { domain: string; glued: boolean } | null {
  const d = emailDomain.toLowerCase();
  const own = canonDomain(company.domain);
  if (own) {
    if (d === own || d.endsWith(`.${own}`)) return { domain: own, glued: false };
    // The company's site on a subdomain, its mail on the parent: group.vattenfall.com, press@vattenfall.com.
    if (own.endsWith(`.${d}`) && d.includes('.')) return { domain: d, glued: false };
    if (d.startsWith(own) && /^[a-z]/.test(d.slice(own.length))) return { domain: own, glued: true };
    return null;
  }
  // No domain on file: the address's own domain must spell the company's name, exactly.
  const squashed = canonCompany(company.name).replace(/\s/g, '');
  const m = d.match(/^([a-z0-9-]+)\.([a-z]{2,6})([a-z]*)$/);
  if (m && m[1] === squashed) return { domain: `${m[1]}.${m[2]}`, glued: !!m[3] };
  return null;
}

export function observePatterns(page: { text: string; url: string; readAt: string }, company: { name: string; domain?: string | null }): Observation[] {
  const out: Observation[] = [];
  const text = page.text ?? '';
  for (const m of text.matchAll(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
    const index = m.index ?? 0;
    if (FRAUD.test(text.slice(Math.max(0, index - 300), index + 300))) continue;
    const dom = ownDomain(m[2], company);
    if (!dom) continue;
    const local = m[1].toLowerCase();
    if (ROLE.test(local)) { out.push({ domain: dom.domain, pattern: 'role', corroborated: false, address: `${local}@${dom.domain}`, name: null, url: page.url, readAt: page.readAt }); continue; }

    // Corroborated: a name printed just before the address produces it, or produces its tail
    // when text glued a word onto the front.
    let hit: Observation | null = null;
    for (const name of namesBefore(text, index)) {
      const f = forms(name).find((x) => local === x.local || (local.endsWith(x.local) && x.local.includes('.') && /[a-z]$/.test(local.slice(0, local.length - x.local.length))));
      if (f) { hit = { domain: dom.domain, pattern: f.pattern, corroborated: true, address: `${f.local}@${dom.domain}`, name, url: page.url, readAt: page.readAt, ...(f.local !== local || dom.glued ? { note: 'recovered from text that ran into the address' } : {}) }; break; }
    }
    if (hit) { out.push(hit); continue; }

    // Not corroborated: only an unambiguous shape counts, and never one glued onto other text.
    if (dom.glued || !/^[a-z][a-z'-]*([._-][a-z][a-z'-]*)?$/.test(local)) continue;
    const shape: Pattern | null = /^[a-z]{2,}\.[a-z]{2,}$/.test(local) ? 'first.last' : /^[a-z]\.[a-z]{2,}$/.test(local) ? 'f.last' : /^[a-z]{2,}_[a-z]{2,}$/.test(local) ? 'first_last' : /^[a-z]{2,}-[a-z]{2,}$/.test(local) ? 'first-last' : null;
    if (shape) out.push({ domain: dom.domain, pattern: shape, corroborated: false, address: `${local}@${dom.domain}`, name: null, url: page.url, readAt: page.readAt });
  }
  // One observation per address.
  return [...new Map(out.map((o) => [o.address, o])).values()];
}

/**
 * high    two or more different addresses, each produced from a name printed beside it
 * medium  one corroborated address, or two uncorroborated ones of the same shape
 * low     a single uncorroborated address
 */
export function confidenceOf(observed: number, corroborated: number): 'high' | 'medium' | 'low' {
  if (corroborated >= 2) return 'high';
  if (corroborated === 1 || observed >= 2) return 'medium';
  return 'low';
}

/**
 * Merge a company's observations into company_email_patterns: one row per (domain, pattern), the
 * examples de-duplicated by address, counts and confidence recomputed from everything seen so far.
 * With dryRun it returns the rows it would write and writes nothing.
 */
export async function recordEmailPatterns(
  db: import('@supabase/supabase-js').SupabaseClient,
  workspaceId: string,
  companyId: string,
  observations: Observation[],
  opts: { dryRun?: boolean } = {},
) {
  const groups = new Map<string, Observation[]>();
  for (const o of observations) groups.set(`${o.domain}|${o.pattern}`, [...(groups.get(`${o.domain}|${o.pattern}`) ?? []), o]);
  const rows: any[] = [];
  for (const [key, obs] of groups) {
    const [domain, pattern] = key.split('|');
    const { data: existing } = opts.dryRun
      ? { data: null as any }
      : await db.from('company_email_patterns').select('examples, first_seen_at').eq('company_id', companyId).eq('domain', domain).eq('pattern', pattern).maybeSingle();
    const examples = new Map<string, any>();
    for (const e of existing?.examples ?? []) examples.set(e.address, e);
    for (const o of obs) if (!examples.has(o.address)) examples.set(o.address, { address: o.address, name: o.name, url: o.url, read_at: o.readAt, corroborated: o.corroborated, ...(o.note ? { note: o.note } : {}) });
    const list = [...examples.values()];
    const corroborated = list.filter((e) => e.corroborated).length;
    const row = {
      workspace_id: workspaceId, company_id: companyId, domain, pattern,
      observed_count: list.length, corroborated_count: corroborated,
      confidence: pattern === 'role' ? 'low' : confidenceOf(list.length, corroborated),
      examples: list.slice(0, 20), last_seen_at: new Date().toISOString(),
      ...(existing?.first_seen_at ? {} : { first_seen_at: new Date().toISOString() }),
    };
    rows.push(row);
    if (!opts.dryRun) {
      const { error } = await db.from('company_email_patterns').upsert(row, { onConflict: 'company_id,domain,pattern' });
      if (error) throw new Error(`could not record ${pattern}@${domain} for company ${companyId}: ${error.message}`);
    }
  }
  return rows;
}
