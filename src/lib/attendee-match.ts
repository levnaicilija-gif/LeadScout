import type { SupabaseClient } from '@supabase/supabase-js';
import { canonCompany } from '@/lib/company-identity';

/**
 * Attendee-list people at a company — the one lookup Hiring now, the lead drawer's recipient choice and
 * Radar's attendee links all use.
 *
 * It used to be `ilike('company_name', '%<first word>%')`, 25 rows, no order. Measured 2026-09-14 against the
 * 12,582-person Copenhagen list and the 23 Hiring now companies: "AF Gruppen ASA" searched "%AF%", filled its
 * 25 rows with people from "Pan African University…" and others, and the drawer offered three of them as AF
 * Gruppen contacts; "dg groep" offered two from "DG Competition – European Commission"; VESTAS, with 99 people
 * on file, showed 2 because the 25 rows ran out first; "NorSea" never reached "NorSea Group AS".
 *
 * Now a person is at the company when their company reads the same under canonCompany (the rule that decides
 * whether two company rows are one), or — for a name of five characters or more — when their company is the
 * company's whole name followed by more words ("Vestas Wind Systems A/S", "NorSea Denmark"): `match: 'group'`,
 * shown with the company as the list wrote it. Short names never group: "DOF" would take in "DOF BirdLife Denmark".
 * The database narrows by one word of the name; canonCompany decides.
 */
export type AttendeeMatch = 'name' | 'group';
export type Attendee = { id: string; name: string; title: string | null; source: string; company_name: string; country: string | null; match: AttendeeMatch };

const GROUP_MIN = 5;

export function attendeeMatch(companyName: string, attendeeCompany: string): AttendeeMatch | null {
  const key = canonCompany(companyName);
  const theirs = canonCompany(attendeeCompany ?? '');
  if (!key || !theirs) return null;
  if (theirs === key) return 'name';
  if (key.length >= GROUP_MIN && theirs.startsWith(`${key} `)) return 'group';
  return null;
}

/** The longest word of the canonical name: what the database can narrow by before canonCompany decides. */
function narrowingWord(companyName: string): string | null {
  const words = canonCompany(companyName).split(' ').filter(Boolean).sort((a, b) => b.length - a.length);
  return words[0] ?? null;
}

export async function attendeesAt(db: SupabaseClient, workspaceId: string, companyName: string, limit = 50): Promise<{ people: Attendee[]; error: string | null }> {
  const word = narrowingWord(companyName);
  if (!word) return { people: [], error: null };
  const found: Attendee[] = [];
  // Paged: a common word ("wind", "energy") narrows to thousands, and a single page would stop at the API's row cap.
  for (let from = 0; from < 10000; from += 1000) {
    const { data, error } = await db.from('people').select('id, name, title, source, company_name, country')
      .eq('workspace_id', workspaceId).ilike('company_name', `%${word.replace(/[%_]/g, '')}%`)
      .order('id').range(from, from + 999);
    if (error) return { people: found, error: error.message };
    for (const p of data ?? []) {
      const match = attendeeMatch(companyName, p.company_name);
      if (match) found.push({ ...(p as any), match });
    }
    if (!data || data.length < 1000) break;
  }
  // The same name first, then the group; within each, the list's order.
  found.sort((a, b) => (a.match === b.match ? 0 : a.match === 'name' ? -1 : 1));
  return { people: found.slice(0, limit), error: null };
}
