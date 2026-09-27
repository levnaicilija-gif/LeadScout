/**
 * The three reasons a company has no contact, and the property that lets two surfaces share them.
 *
 *   npx tsx scripts/site-read-state-check.ts
 *
 * Item 27's cell decision turns on telling three absences apart: nobody has looked, we looked and the
 * site printed nothing, and there is no site to look at. Each is a different action for a recruiter, so
 * collapsing them into one em dash is the defect — and the worked example that started item 27 was
 * exactly that, Schiffswerft Fischer having no website on file while the row said only that nobody was
 * named, which reads as "we looked and found nobody".
 *
 * THE SECOND HALF IS THE ONE WORTH A CHECK. This rule must be readable from BOTH the server-rendered
 * Won work cell and the `'use client'` lead drawer. It began inside `hiring-contacts.ts`, next to
 * `preparedSearches`, which is where it belongs by subject — and that file imports `appearsIn` from
 * `./ai/claude`, so importing it into the drawer would have pulled the Anthropic SDK into the browser
 * bundle. Nothing would have failed loudly; the bundle would just have grown and shipped server code to
 * the client. So the file must stay dependency-free, and that is asserted here rather than remembered.
 */
import { readFileSync } from 'fs';
import { siteReadState } from '../src/lib/site-read-state';

let fail = 0;
const check = (name: string, pass: boolean, detail: string) => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!pass) fail++;
};

// ---- THE THREE STATES, each with the row that produces it ---------------------------------------
check('no domain on file -> no_website', siteReadState({ domain: null }) === 'no_website',
  'the Schiffswerft Fischer case: discovery never ran, so "nobody named" would be a claim nobody checked');
check('no domain, undefined rather than null -> no_website', siteReadState({}) === 'no_website', 'absent and null are the same fact here');
check('a null company -> no_website', siteReadState(null) === 'no_website', 'never throws on a lead whose company embed failed');
check('a domain, never read -> not_read', siteReadState({ domain: 'example.com', contacts_checked_at: null }) === 'not_read',
  'the crawl has not reached it; a recruiter should wait rather than search');
check('a domain, read -> nothing_printed', siteReadState({ domain: 'example.com', contacts_checked_at: '2026-09-15T10:00:00Z' }) === 'nothing_printed',
  'we looked; a search is the remaining action');

// The arms that stop the rule collapsing: each input must give a DIFFERENT answer, which is the whole
// requirement. A rule that returned one constant would pass any single assertion above.
const three = new Set([
  siteReadState({ domain: null }),
  siteReadState({ domain: 'example.com', contacts_checked_at: null }),
  siteReadState({ domain: 'example.com', contacts_checked_at: '2026-09-15T10:00:00Z' }),
]);
check('the three states are DISTINGUISHABLE', three.size === 3, `${three.size} distinct answer(s): ${[...three].join(', ')}`);

// An empty-string domain is "no website", not a website called "". Postgres stores either.
check('an empty-string domain is no_website', siteReadState({ domain: '' }) === 'no_website', 'a blank is not a site');

// ---- AND THE REASON IT IS ITS OWN FILE ----------------------------------------------------------
const src = readFileSync('src/lib/site-read-state.ts', 'utf8');
const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l));
check('site-read-state.ts imports NOTHING', imports.length === 0,
  imports.length ? `it imports: ${imports.join(' | ')} — a client component importing this would pull them into the browser bundle` : 'safe for a client component');

// Both surfaces must actually use it, or the rule is shared in name only.
for (const [file, what] of [
  ['src/app/app/(rail)/radar/page.tsx', "Won work's Decision-maker cell"],
  ['src/components/LeadDrawer.tsx', "the lead drawer's prepared-searches note"],
] as [string, string][]) {
  const body = readFileSync(file, 'utf8');
  check(`${what} uses the shared rule`, /siteReadState\(/.test(body) && /site-read-state/.test(body),
    /siteReadState\(/.test(body) ? 'imported and called' : 'NOT USED — the three-way branch has drifted back into this file');
}

// The drawer is a client component, which is the fact that forced the split. If it ever stops being
// one this check should stop claiming that as the reason.
check('the lead drawer is still a client component', /^'use client';/.test(readFileSync('src/components/LeadDrawer.tsx', 'utf8')),
  "it is why the rule cannot live behind a server-only import");

console.log(`\nsite read state: ${fail ? `${fail} FAILED` : 'all checks passed'}`);
if (fail) process.exitCode = 1;
