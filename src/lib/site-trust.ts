import { siteScope } from './site-scope';

/**
 * How far a company's website — and so every contact read off it — can be trusted, in words for the drawer.
 *
 * Owner's requirement, 2026-09-15: ALLEZ ENERGIES' general email came from allez.fr, a site that does not print the award
 * notice's address, and it looked exactly like a contact from a confirmed site; COLAS FRANCE's switchboard came from
 * colas.com, the group's site. A contact must say which it is.
 *
 * Reads 0033's columns when they are filled; before 0033 (or for batch 1 before the migration moved it) the check
 * written into companies.source as 'web search · …'; and when no scope was stored, the group rule on name and domain. A
 * domain the award notice itself printed (set at ingest with source 'ted award notice') is confirmed by the notice. A
 * domain from anywhere else, never checked, says nothing — it is not called confirmed or unconfirmed.
 */
export type SiteCheck = 'printed' | 'not_printed' | 'site_did_not_load' | 'no_address' | 'from_notice';
export type SiteTrust = {
  check: SiteCheck | null;
  scope: 'own' | 'group';
  confirmed: boolean;
  /** The lines to show, most important first. */
  lines: { tone: 'ok' | 'warn' | 'neutral'; kind: 'scope' | 'check'; text: string }[];
  /** Short words for the table row, or null. */
  rowNote: string | null;
};

type Company = {
  name?: string | null; domain?: string | null; country?: string | null; source?: string | null;
  domain_source?: string | null; domain_address_check?: string | null; domain_checked_address?: string | null;
  domain_scope?: string | null; domain_scope_reason?: string | null;
};

const LEGACY: Record<string, SiteCheck> = {
  'web search · address printed on the site': 'printed',
  'web search · address not printed on the site': 'not_printed',
  'web search · site did not load for the address check': 'site_did_not_load',
  'web search · no address in the notice': 'no_address',
};

export function siteTrust(co: Company | null | undefined): SiteTrust | null {
  if (!co?.domain) return null;
  const check: SiteCheck | null = (co.domain_address_check as SiteCheck | null)
    ?? LEGACY[co.source ?? '']
    ?? (co.source === 'ted award notice' && !co.domain_source ? 'from_notice' : null);
  const stored = co.domain_scope === 'own' || co.domain_scope === 'group';
  const scoped = stored ? { scope: co.domain_scope as 'own' | 'group', reason: co.domain_scope_reason ?? null } : siteScope({ companyName: co.name ?? '', domain: co.domain, winnerCountry: co.country });
  const where = co.domain_checked_address ? ` (${co.domain_checked_address})` : '';
  const lines: SiteTrust['lines'] = [];
  if (scoped.scope === 'group') {
    lines.push({ tone: 'warn', kind: 'scope', text: `This looks like the group's website, not ${co.name}'s own${scoped.reason ? `: ${scoped.reason}` : ''}. A switchboard or address here may reach the group, not the operation that won the work.` });
  }
  if (check === 'printed') lines.push({ tone: 'ok', kind: 'check', text: `Confirmed: ${co.domain} prints the award notice's address${where}.` });
  if (check === 'from_notice') lines.push({ tone: 'ok', kind: 'check', text: `Confirmed: the award notice itself gives ${co.domain} as the winner's website.` });
  if (check === 'not_printed') lines.push({ tone: 'warn', kind: 'check', text: `Not confirmed: ${co.domain} does not print the award notice's address${where}. Check it is the right company before calling.` });
  if (check === 'site_did_not_load') lines.push({ tone: 'neutral', kind: 'check', text: `Not confirmed: ${co.domain} did not load when it was checked against the award notice's address${where}.` });
  if (check === 'no_address') lines.push({ tone: 'neutral', kind: 'check', text: `Not confirmed: the award notice gives no address to check ${co.domain} against.` });
  const confirmed = check === 'printed' || check === 'from_notice';
  const notes = [check && !confirmed ? 'unconfirmed' : null, scoped.scope === 'group' ? 'group site' : null].filter(Boolean);
  return { check, scope: scoped.scope, confirmed, lines, rowNote: notes.length ? notes.join(' · ') : null };
}
