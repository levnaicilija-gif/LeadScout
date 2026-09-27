/**
 * WHY WE HAVE NO CONTACT FOR THIS COMPANY — the three states, in one place (item 27, 2026-09-27).
 *
 * "None found" is three different facts and they call for three different actions: nobody has looked
 * yet, we looked and the site printed nothing, or there is no site to look at. Collapsing them into a
 * blank cell or a bare em dash is the thing item 27 set out to fix, because a recruiter cannot tell
 * whether to run a search, wait for the crawl, or go and find the website themselves. The worked
 * example that started item 27 was exactly this: Schiffswerft Fischer GmbH had no website on file, so
 * discovery never ran — and the row said only that nobody was named, which reads as "we looked".
 *
 * SHARED RATHER THAN DUPLICATED. The lead drawer has stated these three since item 21, in its own
 * longer sentences; the Won work table cell needs the same distinction in a few words. Two copies of a
 * three-way rule is how they drift, and the drifted one is the one nobody reads.
 *
 * ITS OWN FILE, WITH NO IMPORTS, AND THAT IS THE POINT. This started life inside `hiring-contacts.ts`
 * beside `preparedSearches`, which is where it belongs by subject — and that file imports `appearsIn`
 * from `./ai/claude`, so a client component importing it would pull the Anthropic SDK into the browser
 * bundle. `LeadDrawer` is `'use client'`. A rule that two surfaces must share cannot live behind a
 * server-only import, so it lives here with no dependencies at all.
 *
 * `contacts_checked_at` is the discriminator for "we looked", and it is the same stamp the discovery
 * cache uses (a company is read once in 30 days), so this cannot disagree with whether a read happened.
 */
export type SiteReadState = 'no_website' | 'not_read' | 'nothing_printed';

export function siteReadState(
  co: { domain?: string | null; contacts_checked_at?: string | null } | null | undefined,
): SiteReadState {
  if (!co?.domain) return 'no_website';
  return co.contacts_checked_at ? 'nothing_printed' : 'not_read';
}
