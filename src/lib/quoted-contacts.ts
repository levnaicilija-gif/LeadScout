/**
 * Who, of the people an article quotes, is worth writing to — decided by rank order, no model call.
 *
 * Same pattern as item 13's organisation-page contacts: every name and title must be verbatim in
 * the page, and a fixed order says who is best. What is new is excluding people regardless of
 * seniority: a journalist, an official, an analyst, a consents or communications lead, or someone
 * who works for a DIFFERENT company — the client who awarded the work is not the company hiring for it.
 *
 * Employer comes from the article text only, in this order:
 *   1. the title names our company ("CEO of DWT's offshore division")          → ours
 *   2. the title names another organisation ("Offshore Manager at EWE's…")    → other company
 *   3. the title names nobody ("CEO"): the attribution sentence names our company, or the page is
 *      on our company's own site                                               → ours
 *   4. otherwise                                                               → not established
 */
import { canonCompany, canonDomain } from './company-identity';
import { isCLevel, isOps } from './contact-choice';
import { primaryRank } from './hiring-contacts';
import { appearsIn } from './ai/claude';

export type Quoted = { name: string; title: string; quote?: string | null; employer?: string | null };
export type Kept = Quoted & { rank: 1 | 2 | 3 | 4; why: string };
export type Excluded = { name: string; title: string; rule: 'rep_excluded_role' | 'rep_other_company'; why: string };
export type ContactChoice = { kept: Kept[]; excluded: Excluded[]; unverified: (Quoted & { why: string })[]; primary: Kept | null; why: string };

const words = (s: string) => ` ${canonCompany(s)} `;

/**
 * The names an article may use for the company: its canonical name, a bracketed part on its own
 * ("DWT (Deutsche Windtechnik)" → "dwt" and "deutsche windtechnik"), an acronym written in capitals
 * inside the name itself, and the company's domain label.
 */
export function companyAliases(name: string, domain?: string | null): string[] {
  const out = new Set<string>();
  const add = (s?: string | null) => { const c = s ? canonCompany(s) : ''; if (c.replace(/\s/g, '').length >= 2) out.add(c); };
  add(name);
  const inner = name.match(/\(([^)]+)\)/)?.[1];
  add(inner);
  add(name.replace(/\([^)]*\)/g, ''));
  for (const t of name.match(/\b[A-Z]{2,6}\b/g) ?? []) add(t);
  const label = canonDomain(domain).split('.')[0];
  if (label) add(label.replace(/-/g, ' '));
  return [...out];
}

const namesAlias = (text: string, aliases: string[]) => aliases.some((a) => words(text).includes(` ${a} `));

/** Roles that are never who books trades, however senior. */
const EXCLUDED_ROLE: { re: RegExp; what: string }[] = [
  { re: /\b(editor|journalist|reporter|correspondent|columnist)\b/i, what: 'a journalist' },
  { re: /\b(minister|state secretary|secretary of state|mp|mep|senator|mayor|governor|councillor|commissioner|ambassador|ministry|regulator)\b/i, what: 'a politician or official' },
  { re: /\banalyst\b|wood mackenzie|rystad|bnef/i, what: 'an analyst' },
  { re: /\b(consents?|consenting|permitting|land|environment(al)?|stakeholder|community|public affairs|government affairs|communications?|media relations|press officer|spokes\w+|investor relations|legal|general counsel|company secretary|treasurer|sustainability|esg|marketing)\b/i, what: 'a role that does not hire trades' },
];

export function excludedRole(title: string): string | null {
  const hit = EXCLUDED_ROLE.find((r) => r.re.test(title));
  return hit ? hit.what : null;
}

/**
 * An organisation the title names that is not ours: "at X", or a possessive "X's". Only words
 * starting with a capital count, and generic words that follow "at" are skipped.
 */
function otherOrgInTitle(title: string, aliases: string[]): string | null {
  const GENERIC = /^(the|our|its|their|a|an|group|head|global|offshore|onshore|business|operations|projects?)$/i;
  const candidates: string[] = [];
  for (const m of title.matchAll(/\bat\s+((?:[A-Z][\p{L}&.-]*(?:['’]s)?\s?){1,4})/gu)) candidates.push(m[1]);
  for (const m of title.matchAll(/\b([A-Z][\p{L}&.-]{1,})['’]s\b/gu)) candidates.push(m[1]);
  for (const raw of candidates) {
    const org = raw.replace(/['’]s\b/g, '').trim();
    const first = org.split(/\s+/)[0];
    if (!org || GENERIC.test(first)) continue;
    if (namesAlias(org, aliases)) continue;
    return org;
  }
  return null;
}

/** The sentence a name appears in, with some room either side. */
function around(text: string, name: string, room = 200) {
  const i = text.toLowerCase().indexOf(name.toLowerCase());
  return i < 0 ? '' : text.slice(Math.max(0, i - room), i + name.length + room);
}

export type EmployerContext = { text: string; aliases: string[]; sourceUrl: string; companyName: string; companyDomain?: string | null; targets: Set<string> };

export function employerOf(p: Quoted, ctx: EmployerContext): { kind: 'ours' | 'other' | 'none'; detail: string; org?: string } {
  if (namesAlias(p.title, ctx.aliases)) return { kind: 'ours', detail: `the title names ${ctx.companyName} ("${p.title}")` };
  const other = otherOrgInTitle(p.title, ctx.aliases);
  if (other) return { kind: 'other', detail: `the title names ${other} ("${p.title}")`, org: other };
  if (namesAlias(around(ctx.text, p.name), ctx.aliases)) return { kind: 'ours', detail: `the sentence quoting them names ${ctx.companyName}` };
  let host = '';
  try { host = canonDomain(new URL(ctx.sourceUrl).hostname); } catch { /* not a URL */ }
  const ownSite = (ctx.companyDomain && host && (host === canonDomain(ctx.companyDomain) || host.endsWith(`.${canonDomain(ctx.companyDomain)}`)))
    || (host && ctx.aliases.some((a) => host.split('.').slice(-2)[0] === a.replace(/\s/g, '')));
  if (ownSite) return { kind: 'ours', detail: `the article is on ${ctx.companyName}'s own site (${host})` };
  if (p.employer && namesAlias(p.employer, ctx.aliases) && appearsIn(around(ctx.text, p.name, 300), p.employer)) {
    return { kind: 'ours', detail: `the article names their employer as ${p.employer}` };
  }
  return { kind: 'none', detail: 'the article does not say who they work for' };
}

const EVENT = /\b(project (manager|director)|site|offshore (manager|operations)|operations|construction|installation|commissioning|maintenance|service)\b/i;
const LINE = /\b(division|business unit|segment|region)\b/i;

/** Lower is better. 1 tied to the work, 2 leads the part of the business doing it, 3 other staff, 4 group top. */
export function rankQuoted(p: Quoted, project: { name?: string | null; location?: string | null }): { rank: 1 | 2 | 3 | 4; what: string } {
  const pr = primaryRank(p.title);
  if (isOps(p.title) || pr || EVENT.test(p.title)) return { rank: 1, what: pr?.what ?? 'tied to the work itself' };
  const projectWords = new Set(`${project.name ?? ''} ${project.location ?? ''}`.toLowerCase().match(/\p{L}{5,}/gu) ?? []);
  if (LINE.test(p.title) || (p.title.toLowerCase().match(/\p{L}{5,}/gu) ?? []).some((w) => projectWords.has(w))) return { rank: 2, what: 'leads the part of the business doing the work' };
  if (!isCLevel(p.title)) return { rank: 3, what: 'a titled representative' };
  return { rank: 4, what: 'group executive, ranked below anyone closer to the work' };
}

export function chooseQuoted(people: Quoted[], ctx: EmployerContext & { project: { name?: string | null; location?: string | null } }): ContactChoice {
  const kept: Kept[] = [];
  const excluded: Excluded[] = [];
  const unverified: (Quoted & { why: string })[] = [];
  const seen = new Set<string>();
  for (const p of people) {
    const key = p.name.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!p.name || !p.title || seen.has(key)) continue;
    seen.add(key);
    const role = excludedRole(p.title);
    if (role) { excluded.push({ name: p.name, title: p.title, rule: 'rep_excluded_role', why: `${p.name} — "${p.title}" is ${role}` }); continue; }
    const emp = employerOf(p, ctx);
    if (emp.kind === 'other') {
      const target = emp.org && ctx.targets.has(canonCompany(emp.org));
      if (!target) { excluded.push({ name: p.name, title: p.title, rule: 'rep_other_company', why: `${p.name} — ${emp.detail}; that is not ${ctx.companyName}, and it is not a target account` }); continue; }
    }
    if (emp.kind === 'none') { unverified.push({ ...p, why: `${p.name} — ${emp.detail}` }); continue; }
    const r = rankQuoted(p, ctx.project);
    kept.push({ ...p, rank: r.rank, why: `${p.name} — ${emp.detail}; ${r.what}` });
  }
  kept.sort((a, b) => a.rank - b.rank);
  const primary = kept[0] ?? null;
  const why = primary
    ? `${primary.why}${kept.length > 1 ? `, ranked above ${kept.slice(1).map((k) => k.name).join(', ')}` : ''}`
    : excluded.length || unverified.length ? 'no quoted person is an outreach target at this company' : 'nobody is quoted by name with a title';
  return { kept, excluded, unverified, primary, why };
}

/**
 * Quoted people found in stored text without a model: "said Name, Title." and "Name, Title, said".
 * Only for re-evaluating stored articles; a live run uses the extraction's people list.
 */
export function quotedInText(text: string): Quoted[] {
  const out: Quoted[] = [];
  const NAME = "([A-Z][\\p{L}'’-]+(?:\\s[A-Z][\\p{L}'’-]+){1,3})";
  for (const m of text.matchAll(new RegExp(`\\bsaid:?\\s+${NAME}\\s*,\\s*([^.;"“”\\n]{3,140}?)\\s*[.;]`, 'gu'))) out.push({ name: m[1], title: m[2].trim() });
  for (const m of text.matchAll(new RegExp(`${NAME}\\s*,\\s*([^,;"“”\\n]{3,140}?)\\s*,\\s*(?:said|says|added|commented|explained)\\b`, 'gu'))) out.push({ name: m[1], title: m[2].trim() });
  return out.filter((p) => appearsIn(text, p.name) && appearsIn(text, p.title));
}
