/**
 * A phone number as a recruiter types it, checked for shape only (item 24): no online lookup, no carrier check, nothing
 * sent anywhere. Stored as typed (tidied), so "+47 912 34 567" stays readable.
 *
 * Accepted: an optional leading + (or 00), digits, and spaces, dashes, dots, slashes or brackets between them; 8 to 15
 * digits in all. Eight, not nine: Norwegian and Danish numbers are eight digits written locally ("912 34 567"), and the
 * first version refused them (candidate-phone-check, 2026-09-15). Fifteen is E.164's maximum. Anything else is refused
 * with what is wrong, never silently rewritten.
 */
export type PhoneCheck = { ok: true; value: string | null } | { ok: false; error: string };

export function checkPhone(input: string | null | undefined): PhoneCheck {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: true, value: null };
  if (/[^\d+\s().\-/]/.test(raw)) return { ok: false, error: 'a phone number has only digits, a leading +, and spaces, dashes, dots, slashes or brackets' };
  if (raw.indexOf('+') > 0 || (raw.match(/\+/g) ?? []).length > 1) return { ok: false, error: 'a + can only come first' };
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8) return { ok: false, error: `${digits.length} digits is too short for a phone number (at least 8)` };
  if (digits.length > 15) return { ok: false, error: `${digits.length} digits is too long for a phone number (at most 15)` };
  let open = 0;
  for (const ch of raw) { if (ch === '(') open++; if (ch === ')') open--; if (open < 0) break; }
  if (open !== 0) return { ok: false, error: 'the brackets do not match' };
  return { ok: true, value: raw.replace(/\s+/g, ' ') };
}

/** An email address, checked for shape only. */
export function checkEmail(input: string | null | undefined): { ok: true; value: string | null } | { ok: false; error: string } {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: true, value: null };
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw) ? { ok: true, value: raw } : { ok: false, error: 'that does not look like an email address' };
}
