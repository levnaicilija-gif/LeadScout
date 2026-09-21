/**
 * When you were last here, and what counts as "while you were out".
 *
 * Owner's decision, 2026-09-17: the stamp advances on Today's own load, and only when more than
 * thirty minutes have passed since the stored value. Two rules follow from that, and both matter:
 *
 *   - The window a recruiter reads stays STILL while they work. Reloading Today at 08:20 does not
 *     collapse "while you were out" into a twenty-minute window — the 17:04 boundary survives until
 *     they have genuinely been away again.
 *   - It is never written in currentUser(). Every screen calls that on every render, so writing
 *     there would advance the value continuously and the card could only ever show an empty window.
 *
 * Pure: no database, no clock of its own. The caller passes both, so the rule is testable.
 */

/** Long enough away to count as a new visit. Below this, the stored boundary is left alone. */
export const VISIT_GAP_MS = 30 * 60 * 1000;

export type Visit = {
  /** The boundary to show: everything after this happened while they were out. Null on a first-ever visit. */
  since: Date | null;
  /** Should the caller write `now` back to users.last_seen_at? */
  advance: boolean;
  /** When this visit began — what the "Since HH:MM" window counts from. */
  arrived: Date;
};

/**
 * @param lastSeen      users.last_seen_at as stored — when THIS visit began — or null on a first visit
 * @param now           the clock, passed in so this can be tested
 * @param previousVisit users.previous_visit_at (0043): when the visit BEFORE this one began.
 *
 * The third argument distinguishes three states, and the difference between the last two is the whole
 * reason 0043 exists:
 *
 *   undefined  the column is not there (0043 unapplied). Behave exactly as before it: a reload inside
 *              a visit reads its own arrival as the boundary. Every screen passes `undefined` through
 *              hasPreviousVisit, so this migration not being applied changes nothing.
 *   null       the column IS there and holds nothing — this account has had one visit and no previous
 *              one. There is no boundary, and inventing their own arrival as one would put a brand-new
 *              recruiter's second page load behind an empty window.
 *   a date     the boundary, and it survives every reload of this visit.
 */
export function visitWindow(lastSeen: string | Date | null | undefined, now: Date, previousVisit?: string | Date | null): Visit {
  const prev = lastSeen ? new Date(lastSeen) : null;
  if (!prev || Number.isNaN(prev.getTime())) {
    // Never been here before: there is no "while you were out", and the stamp is set from now on.
    return { since: null, advance: true, arrived: now };
  }
  const away = now.getTime() - prev.getTime();
  if (away > VISIT_GAP_MS) {
    // A real absence. The boundary is where they left — which is the stamp about to be replaced, and
    // exactly what the route copies into previous_visit_at as it advances.
    return { since: prev, advance: true, arrived: now };
  }
  // Still the same visit. `arrived` stays where it was, which is what keeps "Since 08:00" from
  // creeping to "Since 08:20" on a reload, and nothing is written.
  //
  // The boundary comes from previous_visit_at, because last_seen_at now holds THIS visit's arrival:
  // reading it here is what made the window collapse to the last few minutes on every reload, and
  // with LiveRefresh on Today that was one every five minutes.
  if (previousVisit === undefined) return { since: prev, advance: false, arrived: prev };
  const before = previousVisit === null ? null : new Date(previousVisit);
  const usable = before && !Number.isNaN(before.getTime()) ? before : null;
  return { since: usable, advance: false, arrived: prev };
}

/** "08:00", in the reader's own locale. The label on the live window. */
export const clock = (d: Date) =>
  d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * "you were last here yesterday at 17:04" — the line under the greeting.
 *
 * Says the day only when it was not today, because "last here today at 17:04" reads as a mistake.
 */
export function lastHereLabel(since: Date | null, now: Date): string {
  if (!since) return 'first time here';
  const sameDay = since.toDateString() === now.toDateString();
  if (sameDay) return `you were last here at ${clock(since)}`;
  const yesterday = new Date(now.getTime() - 86400000);
  if (since.toDateString() === yesterday.toDateString()) return `you were last here yesterday at ${clock(since)}`;
  return `you were last here on ${since.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} at ${clock(since)}`;
}

/** Everything at or after the boundary happened while they were out. */
export const whileOut = <T extends { when?: string | null }>(items: T[], since: Date | null, arrived: Date) =>
  items.filter((i) => {
    if (!i.when || !since) return false;
    const t = Date.parse(i.when);
    return !Number.isNaN(t) && t >= since.getTime() && t < arrived.getTime();
  });

/** Everything since they arrived — the live window, which grows while the page is open. */
export const sinceArrived = <T extends { when?: string | null }>(items: T[], arrived: Date) =>
  items.filter((i) => {
    if (!i.when) return false;
    const t = Date.parse(i.when);
    return !Number.isNaN(t) && t >= arrived.getTime();
  });
