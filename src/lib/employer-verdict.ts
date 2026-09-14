export type EmployerType = 'end_client' | 'epc_contractor' | 'staffing_agency' | 'unknown';

/**
 * What a careers-page verdict writes onto a company.
 *
 * Never trade a specific answer for "unknown": the page failing to say so is not evidence that the earlier answer was
 * wrong. But a kept answer keeps its origin too. This used to label every kept type `careers_page`, so a guess from
 * the name that the page did not settle — EnBW Offshore Wind Norway as an EPC contractor, from "offshore" — would
 * have come back from the re-read of 2026-09-15 looking like a careers-page reading.
 */
export function verdictPatch(
  c: { employer_type?: string | null; employer_type_source?: string | null },
  v: { employer_type: EmployerType; evidence: string },
  now = new Date().toISOString(),
): { patch: Record<string, unknown>; changedTo: EmployerType | null } {
  const hadType = !!c.employer_type && c.employer_type !== 'unknown';
  if (v.employer_type === 'unknown' && hadType) {
    if (c.employer_type_source === 'careers_page') {
      return { patch: { employer_type_evidence: v.evidence, employer_type_checked_at: now }, changedTo: null };
    }
    return {
      patch: {
        employer_type_source: 'name',
        employer_type_reason: 'the careers page does not say what kind of company this is; the type shown is a guess from the name',
        employer_type_evidence: `careers page does not settle it: ${v.evidence}`,
        employer_type_checked_at: now,
      },
      changedTo: null,
    };
  }
  return {
    patch: { employer_type: v.employer_type, employer_type_source: 'careers_page', employer_type_evidence: v.evidence, employer_type_checked_at: now },
    changedTo: v.employer_type !== c.employer_type ? v.employer_type : null,
  };
}
