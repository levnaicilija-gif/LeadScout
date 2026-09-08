/** Port of salvage/agencyDetector.ts — keep the agency list in sync with seeds/agencies.csv */
import type { EmployerType } from './types';
const AGENCY_HINTS = ['recruit', 'staffing', 'manpower', 'personnel', 'bemanning', 'personell', 'uitzend', 'interim', 'talent', 'resourcing', 'workforce', 'crewing', 'crew management', 'agency'];
const EPC_HINTS = ['epc', 'engineering', 'contractor', 'construction', 'fabrication', 'offshore', 'marine', 'shipyard', 'yard', 'industries', 'energy services'];
export function detectEmployerType(company: string, knownAgencies: string[] = []): { employerType: EmployerType; reason: string } {
  const n = company.toLowerCase();
  if (knownAgencies.some((a) => n.includes(a.toLowerCase()))) return { employerType: 'staffing_agency', reason: 'in agency list' };
  if (AGENCY_HINTS.some((h) => n.includes(h))) return { employerType: 'staffing_agency', reason: 'agency keyword in name' };
  if (EPC_HINTS.some((h) => n.includes(h))) return { employerType: 'epc_contractor', reason: 'contractor keyword in name' };
  return { employerType: 'unknown', reason: 'no signal in name' };
}
