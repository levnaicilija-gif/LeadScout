/**
 * "Industry Contacts" is what people from event and industry lists are called on screen (owner's rename, 2026-09-15).
 *
 * The data keeps its names: the `people` and `lead_people` tables, the matching in src/lib/attendee-match.ts, and the
 * `source` each person was imported with ("WindEurope Copenhagen attendee list", "WindEurope Annual Event 2026"). Only
 * what is shown changes, here, so a stored value never leaks the old wording onto a screen or into a draft's reason.
 */
export const INDUSTRY_CONTACTS = 'Industry Contacts';

export function industryContactsLabel(source: string | null | undefined): string {
  return String(source ?? '').replace(/\battendee[- ]lists?\b/gi, INDUSTRY_CONTACTS).replace(/\battendees?\b/gi, INDUSTRY_CONTACTS).trim();
}
