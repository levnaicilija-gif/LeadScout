import { canonCompany } from '@/lib/company-identity';
import { isOps } from '@/lib/contact-choice';

/**
 * Adding a second attendee list without a second copy of anyone (scripts/import-attendees.ts). Pure: it plans,
 * the script writes, scripts/attendee-import-check.ts proves the plan.
 *
 * A person is the same person when the name reads the same (case and spacing aside) at a company that reads the
 * same under canonCompany — "AIBEL AS" and "AIBEL" are one company. Name alone is not enough: 932 names in the
 * Annual Event 2026 list also appear in Copenhagen at a different company. A group match (attendee-match.ts)
 * never merges people: "DOF Denmark" and "DOF BirdLife Denmark" are different employers.
 *
 * A match keeps its row and gains the event in seen_at_events (0030). When the newer list gives a different
 * title, the row takes the newer title and the old one goes to title_history with the list it came from. A list
 * that says nothing about the title (blank, or an email hidden by the site) changes nothing. The incoming list is
 * taken to be the newer one; the importer says so on every run.
 */
export type IncomingAttendee = { name: string; company_name: string; title: string | null; country: string | null };
export type ExistingPerson = {
  id: string; name: string; company_name: string; title: string | null; country: string | null; source: string;
  ops_relevant?: boolean | null; seen_at_events?: string[] | null; title_history?: { title: string | null; source: string; replaced_at: string }[] | null;
};
export type PersonInsert = { name: string; company_name: string; title: string | null; country: string | null; source: string; ops_relevant: boolean; seen_at_events: string[] };
export type PersonUpdate = { id: string; seen_at_events: string[]; title?: string | null; title_history?: ExistingPerson['title_history']; ops_relevant?: boolean; country?: string | null };

const clean = (s: string | null | undefined) => (s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

export function personKey(name: string, company: string): string | null {
  const n = clean(name).toLowerCase();
  const c = canonCompany(clean(company));
  return n && c ? `${n}|${c}` : null;
}

export function planImport(existing: ExistingPerson[], incoming: IncomingAttendee[], event: string, now: string) {
  const byKey = new Map<string, ExistingPerson>();
  let existingDuplicates = 0;
  for (const e of existing) {
    const k = personKey(e.name, e.company_name);
    if (!k) continue;
    if (byKey.has(k)) existingDuplicates++; else byKey.set(k, e);
  }
  const inserts: PersonInsert[] = [];
  const updates: PersonUpdate[] = [];
  const titleChanges: { name: string; company: string; from: string | null; to: string }[] = [];
  const seen = new Set<string>();
  let unusable = 0, repeatedInList = 0, alreadyRecorded = 0;

  for (const p of incoming) {
    const k = personKey(p.name, p.company_name);
    if (!k) { unusable++; continue; }
    if (seen.has(k)) { repeatedInList++; continue; }
    seen.add(k);
    const title = clean(p.title) || null;
    const country = clean(p.country) || null;
    const e = byKey.get(k);
    if (!e) {
      inserts.push({ name: clean(p.name), company_name: clean(p.company_name), title, country, source: event, ops_relevant: isOps(title), seen_at_events: [event] });
      continue;
    }
    const events = e.seen_at_events?.length ? e.seen_at_events : [e.source];
    // Already imported from this list: a rerun changes nothing.
    if (events.includes(event)) { alreadyRecorded++; continue; }
    const update: PersonUpdate = { id: e.id, seen_at_events: [...events, event] };
    if (title && title.toLowerCase() !== clean(e.title).toLowerCase()) {
      update.title = title;
      update.title_history = [...(e.title_history ?? []), { title: e.title, source: events[events.length - 1], replaced_at: now }];
      update.ops_relevant = isOps(title);
      titleChanges.push({ name: e.name, company: e.company_name, from: e.title, to: title });
    }
    if (!e.country && country) update.country = country;
    updates.push(update);
  }
  return { inserts, updates, titleChanges, unusable, repeatedInList, alreadyRecorded, existingDuplicates };
}
