/**
 * What a company is to RFBT: someone who employs trades (a customer), or someone who supplies
 * them (a competitor).
 *
 * The name is weak evidence and was once treated as strong. Two faults did real damage:
 * seeds/agencies.csv is a list of firms RFBT competes with for people, which includes EPC
 * contractors who employ trades directly — Worley's own entry reads "Energy EPC & services" —
 * and the known-agency test matched on substrings, so once "Worley" carried the label it spread
 * to "Worley Rosenberg" and "Worley Consulting". Subsea 7, Boskalis, Van Oord and Heerema were
 * all hidden from Hiring now as competitors.
 *
 * So: whole names only, and a name that also says what the company builds is not an agency.
 */
import type { EmployerType } from './types';

const AGENCY_HINTS = [
  'recruit', 'staffing', 'manpower', 'personnel', 'bemanning', 'personell', 'uitzend', 'interim',
  'resourcing', 'workforce', 'crewing', 'crew management', 'agency', 'detacher', 'secondment',
  'werving', 'vakmensen', 'payroll', 'flexwerk', 'arbeidsbemiddeling', 'professionals',
  'employment', 'jobcenter', 'headhunt',
];

/** Words that mean the company does the work itself, and outrank a vague agency-ish name. */
const EMPLOYER_HINTS = [
  'epc', 'engineering', 'contractor', 'construction', 'fabrication', 'offshore', 'marine',
  'shipyard', 'yard', 'industries', 'industrial services', 'energy services', 'maintenance',
  'insulation', 'dredging', 'installation', 'subsea', 'werft', 'verft',
];

/** "NES Fircroft" and "nes-fircroft" are the same firm; "Worley" and "Worley Rosenberg" are not. */
const canon = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(a\/s|aps|as|ab|oy|oyj|gmbh|bv|nv|ltd|limited|llc|inc|plc|sa|sas|spa|group|holding)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();

export function detectEmployerType(company: string, knownAgencies: string[] = []): { employerType: EmployerType; reason: string } {
  const n = company.toLowerCase();
  const key = canon(company);

  // Whole name, not substring. A list entry may never capture a longer name that contains it.
  if (knownAgencies.some((a) => canon(a) === key)) return { employerType: 'staffing_agency', reason: 'named in the agency list' };

  const agencyWord = AGENCY_HINTS.find((h) => n.includes(h));
  const employerWord = EMPLOYER_HINTS.find((h) => n.includes(h));

  // "Offshore Personnel Services" is an agency; "Kaefer Industrial Services" is not.
  if (agencyWord && !employerWord) return { employerType: 'staffing_agency', reason: `"${agencyWord}" in the name` };
  if (employerWord) return { employerType: 'epc_contractor', reason: `"${employerWord}" in the name` };
  return { employerType: 'unknown', reason: 'nothing in the name says either way' };
}

/** The value the rest of the system should use: a person's decision beats the detector. */
export const effectiveEmployerType = (c: { employer_type?: string | null; employer_type_override?: string | null }) =>
  (c.employer_type_override ?? c.employer_type ?? 'unknown') as EmployerType;
