/**
 * The number a recruiter sees for a candidate (item 24, owner's decision 2026-09-15): the digits of the reference code,
 * so RFBT-P-0004 is #4. Nothing is renumbered — the code stays stored and keeps naming public /v/<code> links and PDF
 * files — and new candidates continue from the same sequence, so numbers have gaps where test runs used them.
 * 0035 stores the same number as candidates.candidate_number; this reads it before 0035 is applied, and from any code.
 */
export const candidateNumber = (reference?: string | null): number | null => {
  const digits = String(reference ?? '').match(/(\d+)\s*$/)?.[1];
  return digits ? Number(digits) : null;
};

/** "#4", or the stored code when it carries no number. */
export const candidateLabel = (reference?: string | null): string => {
  const n = candidateNumber(reference);
  return n === null ? (reference || '—') : `#${n}`;
};
