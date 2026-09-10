# LeadScout — instructions for Claude Code

Read `LeadScout-build-prompt.txt` (full spec) and open the file in `design/` that matches the screen before changing UI: `leadscout.html` (rail screens), `leadscout-home-v2.html` (Home), `verify-v2.html` (Verify).

## The rule that overrides everything
Never fabricate. Every contact, email, phone, date or "verified" flag must come from a fetched page (stored with URL + time) or be shown as `pattern` / `unknown`. `src/lib/ai/claude.ts#appearsIn` is the check — keep using it. No Math.random() in data paths. Nothing is emailed except through `/api/outreach`, by a recruiter, to an address attached to a contact/company.

Two corollaries learned the hard way:
- **A model asked for JSON will answer under different keys.** `askJson` takes the required keys from the schema itself and retries once with the zod complaint fed back. Never add a prompt that describes its shape in prose only.
- **A claim about our own people needs evidence behind it.** Bullets are audited against the profile (`checkBullets`), draft emails against the pool (`checkDraft`). Both name the offending phrase rather than silently dropping it.

## Before every commit, and after every deploy
Standing instruction from the user:

```
npm run typecheck && npm run build
npx next start -p <port>                     # serve the build you are about to commit
npx tsx --env-file=.env.local scripts/pdf-check.ts
npx tsx --env-file=.env.local scripts/verify-e2e.ts       http://localhost:<port>
npx tsx --env-file=.env.local scripts/lead-drawer-e2e.ts  http://localhost:<port>
npx tsx --env-file=.env.local scripts/smoke.ts            http://localhost:<port>
```

After deploying, run `scripts/smoke.ts https://leadscout-rfbt.vercel.app` and report pass/fail per flow. If anything regresses, fix it before moving on — never leave production broken to continue a feature. Kill the old `next start` first (`taskkill //PID <pid> //F`): a stale server serves old chunks and produces false failures.

**Migrations are applied by hand by the user, so a deploy can land before its schema.** Never name a new column without guarding it — `src/lib/schema-features.ts#hasColumn` asks once per process. A missing column fails the *whole* query, which has taken Leads, the drawer and Verify down.

**A migration that adds a unique index must dedupe inside the migration.** 0014 failed on live data holding the same source_url twice. Adding the index is not the job; making the data satisfy it is. Keep the oldest row so `first_seen_at` still means what it says, and re-point references before deleting.

**`findOrCreateCompany` is the only way to create a company.** Four jobs each matched on their own `ilike name`, which is how "Equinor" and "Equinor ASA" became two rows and the unique index would not build. `src/lib/company-identity.ts` holds the one rule; it is deliberately cautious, because a wrong merge moves another company's provenance onto the survivor with no way back.

## State of the codebase
- **Migrations 0001–0014 applied. 0015 (campaigns) is written and waiting.**
  0011 source tiers + `radar_runs` · 0012 employer-type override · 0013 right to work + `workspaces.candidate_countries` · 0014 job boards · 0015 campaigns.
- **Radar**: 600 sources tiered by Haiku — priority 44 / standard 189 / off 366, each with a stored reason. Priority daily, everything on Sundays, one cron. `repair-sources` finds a newsroom again when a URL rots and follows a rebrand (Wood → woodgroup.com). 29 won-work leads.
- **Hiring now**: careers/ATS discovery **complete** — 348 boards found, 193 none, 44 unreachable, 0 queued. 16 ATS vendors; Workday needs a POST. Crawl: fingerprint → Haiku titles (which also map trades from the source language) → Sonnet bodies, €2/day cap. ~40 open postings, one row per company, sorted by pressure, agencies hidden by default. Job boards are the **secondary** source: poster and employer recorded separately, an unnamed employer stays unnamed, and an advert repeating a company's own page is marked a duplicate.
- **Campaigns**: batch + required documents; Today shows who is short and shouts inside three weeks. A document counts only when a file of that type is on the candidate.
- **Verify**: one drop zone, recognises by content. CV card streams Read → Anonymized → Bullets → PDF → Questions, match-aware when a job is selected. Adapters `frosio`, `pcn` live; **cswip, ampp, irata, winda, cisrs, electrical_dk still TODO** (`src/lib/verify/adapters/types.ts`) — confirm selectors against the live site and record them in the file.
- **Right to work**: `src/lib/right-to-work.ts` is the single rule, keyed on the **lead's** country. EU job → EU/EEA passport. UK job → an EU passport is *not* enough. `unknown` never passes. Search countries follow the job; never Serbia by default.
- **Screens**: Home (day < 8 lands here, logo always goes Home), Today, Leads (Won work / Hiring now), Verify, Pitch, Candidates, Campaigns, Settings, public `/v/[slug]`.
- **Chains**: every chained job dispatches the next batch *before* doing its own work. Doing it after means one 300 s timeout kills the run — this has bitten Radar, discovery and the job crawl.
- **`supabaseAdmin` sends `cache: 'no-store'`.** Next's Data Cache froze a query result across deploys and `/v/<slug>` served "Not found" for a candidate that existed.

## The queue
`LeadScout-prompt-queue.txt` is authoritative. These numbers are its numbers — never renumber them locally.

| # | Block | State |
|---|---|---|
| 1–3 | Domains → careers/ATS → job-post crawl → Hiring now | **done** |
| 4 | Job boards, secondary crawl | **done** — poster/employer kept separate, duplicates marked. Source list not yet narrowed to the named boards (Jobindex, Finn.no, EURES, Werk.nl, CV-Library, Reed) or pruned of aggregators. |
| 5 | Match-aware screening questions | **part done** — generated from the score, on the score card and in Verify. Still to do: the "Start screening call" view, answers saved against the candidate, answers feeding back into the score, and storing questions/answers with `lead_id` / `job_post_id` / `jd_version`. |
| 6 | Re-score + re-crawl | **part done** — DWT and Proserv contacts recovered; Nadara re-read as a Stage 1 false positive (permitting, not an award) and still needs a decision. Still to do: re-score every lead under the geography gate and fixed trade inference, and a "Re-check" action on the lead drawer. |
| 7 | Replies on the lead (Resend inbound) | **blocked** — waiting on the user's domain verification. |
| 8 | Campaigns + Today missing documents + expiry alerts | **part done** — campaigns, required documents, Today's missing-documents line, expired vs expiring. Still to do: received/verified/missing per document, "ready to send" count, "Send N packs", group numbers, 60/30/7 alerts with a drafted renewal, and an expired certificate marking a candidate unavailable for roles that require it. |
| 9 | New-hire path: trade cards, glossary, day gating | **in progress** |
| 10 | Compounding features — bench forecast, renewal radar, outcome learning | later |
| — | Design pass (Claude Design MCP) | after real data is on screen |

Also outstanding, outside the queue: the remaining verify adapters (cswip, ampp, irata, winda, cisrs, electrical_dk), and watching the first unattended overnight run of the recheck cron.

Commit to main, two lines per step. Keep files small; one screen per file; no UI libraries. Design tokens live in `tailwind.config.js`.
