# LeadScout — instructions for Claude Code

Read `LeadScout-build-prompt.txt` (full spec) before changing UI. `design/leadscout-design-v4.html` is the current visual language — logo, per-tool colours, Plus Jakarta Sans headings, rounded containers and badges, two-panel login — and overrides the older files where they disagree. The earlier files still hold the layout and copy of individual screens: `leadscout.html` (rail screens), `leadscout-home-v2.html` (Home), `verify-v2.html` (Verify).

Tool colours only ever come from `src/lib/tool-colour.ts` — Tailwind cannot build a class name at runtime, so `bg-tool-${x}` renders nothing. A colour says which tool; `ok`/`warn`/`bad` say how a fact stands. Never mix the two.

Every screen is checked at desktop and 390px: `SCREEN_BASE=… npx tsx --env-file=.env.local scripts/design-shots.ts` signs in as a real user, shoots both widths and fails on sideways scroll.

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
npx tsx --env-file=.env.local scripts/pdf-name-audit.ts   # every stored client PDF, every version
npx tsx --env-file=.env.local scripts/verify-e2e.ts       http://localhost:<port>
npx tsx --env-file=.env.local scripts/lead-drawer-e2e.ts  http://localhost:<port>
npx tsx --env-file=.env.local scripts/smoke.ts            http://localhost:<port>
```

After deploying, run `scripts/smoke.ts https://leadscout-rfbt.vercel.app` and report pass/fail per flow. Against a deployed base smoke first waits for `/api/health` to report the commit under test and exits 2 if it never matches — a run started seconds after a push tested the previous build and reported four failures against correct code. If anything regresses, fix it before moving on — never leave production broken to continue a feature. Kill the old `next start` first (`taskkill //PID <pid> //F`): a stale server serves old chunks and produces false failures.

**Migrations are applied by hand by the user, so a deploy can land before its schema.** Never name a new column without guarding it — `src/lib/schema-features.ts#hasColumn` asks once per process. A missing column fails the *whole* query, which has taken Leads, the drawer and Verify down.

**A migration that adds a unique index must dedupe inside the migration.** 0014 failed on live data holding the same source_url twice. Adding the index is not the job; making the data satisfy it is. Keep the oldest row so `first_seen_at` still means what it says, and re-point references before deleting.

**A migration that adds a column referencing another table breaks every existing embed between those two tables.** 0013 added `candidates.eu_passport_document_id` and `candidates.uk_right_to_work_document_id`; with `documents.candidate_id` that made three relationships, PostgREST could no longer resolve `candidates(documents(...))`, and it failed the *whole* query — Candidates, the public `/v/<slug>` page and two of Today's six queries all went quiet on the day it was applied. Name the foreign key in every such embed: `documents!candidate_id(...)`.

**No name goes in a storage path, even an internal one.** Every upload site built its key from the file the recruiter dropped, so object storage held `…/cv/1789031300347-Bertescu_Dumitrel_CV_Final_Readable.pdf`. That is never served to a client, but a name in a path turns up in logs, backups, bucket listings and signed URLs, and none of those are places anyone thinks to look. `src/lib/storage-path.ts#documentPath` is the only way to build one: workspace, type, candidate id, a twelve-character digest of the original name, and the extension. Fourteen existing objects were moved by `scripts/rename-document-paths.ts`.

**`scripts/pdf-name-audit.ts` runs whenever a new anonymized CV is generated, not once.** It reads the *rendered* client PDFs — drawn text, the document information dictionary, the storage path, the download filename — because nothing else in the codebase reads the bytes that actually reach a client. Three separate defects in the reading each produced a false "clean" before it was trustworthy (the newline before `endstream` is optional; @react-pdf writes text as hex runs inside TJ arrays; the Info dictionary holds indirect references to UTF-16BE objects), so it now refuses to call a file clean when it extracts under 40 characters or reads no properties. It audits every version, not just the latest: an older PDF is still an object somebody may hold a URL to.

**A screen must never report an absence it did not check.** Candidates read `{ data }` and ignored `{ error }`, so a query that never ran rendered as "No candidates yet" and looked like a true empty pool for weeks. Read the error, and say a query failed when it failed.

**`findOrCreateCompany` is the only way to create a company.** Four jobs each matched on their own `ilike name`, which is how "Equinor" and "Equinor ASA" became two rows and the unique index would not build. `src/lib/company-identity.ts` holds the one rule; it is deliberately cautious, because a wrong merge moves another company's provenance onto the survivor with no way back.

## State of the codebase
- **Migrations 0001–0020 all applied. Nothing is pending.**
  0011 source tiers + `radar_runs` · 0012 employer-type override · 0013 right to work + `workspaces.candidate_countries` · 0014 job boards · 0015 campaigns · 0016 job_posts RLS + `workspace_id` · 0017 employer-type evidence · 0018 trade cards + glossary + onboarding review · 0019 `cert_library` + `cert_unknown` + attach trail · 0020 posting contacts, company contact page, hiring row state, `outreach.company_id`, `is_test` on eight tables.
- **Radar**: 600 sources tiered by Haiku — priority 44 / standard 189 / off 366, each with a stored reason. Priority daily, everything on Sundays, one cron. `repair-sources` finds a newsroom again when a URL rots and follows a rebrand (Wood → woodgroup.com). 29 won-work leads.
- **Hiring now**: careers/ATS discovery **complete** — 348 boards found, 193 none, 44 unreachable. 16 ATS vendors; Workday needs a POST. Crawl: fingerprint → Haiku titles (which also map trades from the source language) → Sonnet bodies, €2/day cap. 38 open postings across 17 companies, one row per company, sorted by pressure with the reason on hover, filter chips for country/trade/employer/pressure, agencies hidden by default. Each row opens a drawer: postings grouped, employer type with override, Confirm, the four tools reading from the adverts, "Ready to attach" per trade, and a drafted approach. Job boards are the **secondary** source: poster and employer recorded separately, an unnamed employer stays unnamed, and an advert repeating a company's own page is marked a duplicate.
- **Hiring contacts**: five sources, all evidence-gated through `appearsIn` — the advert, the organisation/leadership page, the company contact page, the attendee list, then prepared searches. Measured on 17 real companies (2026-09-13): adverts 6, organisation page 3, switchboard 9, general email 5, attendee list 0, and 6 companies where only searches remain. Only addresses on the company's own domain are kept. A pattern address is labelled `pattern` everywhere and `/api/outreach` refuses to send to one.
- **Certificates**: `src/lib/certs/` decodes ISO 9606 designations and looks up 16 schemes — all in code, no model call. Three layers on the card and one plain-English line per certificate on the client PDF; the raw designation stays visible above the decoding and never reaches a buyer. An unrecognised certificate says so and raises one task per body+level. Seniors edit the library in Settings; a workspace row shadows the shipped one.
- **Sending**: `src/lib/send-capability.ts` is the single check — it asks Resend whether the domain is verified and caches like `schema-features`, so the button turns on by itself when it verifies. The button is never hidden, only disabled with the reason on it. Drafts generate regardless.
- **Campaigns**: batch + required documents; Today shows who is short and shouts inside three weeks. A document counts only when a file of that type is on the candidate.
- **Verify**: one drop zone, recognises by content. CV card streams Read → Anonymized → Bullets → PDF → Questions, match-aware when a job is selected. Adapters `frosio`, `pcn` live; **cswip, ampp, irata, winda, cisrs, electrical_dk still TODO** (`src/lib/verify/adapters/types.ts`) — confirm selectors against the live site and record them in the file.
- **Right to work**: `src/lib/right-to-work.ts` is the single rule, keyed on the **lead's** country. EU job → EU/EEA passport. UK job → an EU passport is *not* enough. `unknown` never passes. Search countries follow the job; never Serbia by default.
- **Screens**: Home (day < 8 lands here, logo always goes Home), Today, Leads (Won work / Hiring now), Verify, Pitch, Candidates, Campaigns, Settings, public `/v/[slug]`.
- **Chains**: every chained job dispatches the next batch *before* doing its own work. Doing it after means one 300 s timeout kills the run — this has bitten Radar, discovery and the job crawl.
- **A check that turns on timing is worse than no check.** Three smoke checks have now had to be rewritten: one slept 1500 ms then asserted, one asserted an upstream outcome ("the upload made a candidate") on a screen that was behaving correctly, and one matched `Job Title|Positions|Responsibilities|Location` and passed on the word "Location" in the lead's own detail line whatever the drawer did. Wait for the thing, ask the database whether the assertion applies, and assert on a stable hook (`data-result`) rather than on wording a model chose.

**A fire-and-forget `fetch` does not reliably survive the response.** The hiring-contacts route dispatched its next batch that way and the batch never ran. Long jobs do one timed pass, record progress per row, and report what is left; a driver script or a cron calls again.

**`supabaseAdmin` sends `cache: 'no-store'`.** Next's Data Cache froze a query result across deploys and `/v/<slug>` served "Not found" for a candidate that existed.

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
| 9 | New-hire path: trade cards, glossary, day gating | **done** — 10 trade cards and 88 glossary terms seeded, English only, rates and rotations deliberately unset |
| 10 | Compounding features — bench forecast, renewal radar, outcome learning | later |
| 11 | Talentmatch three — previously-worked-for, why this score, daily scorecard | **not started** |
| 13 | Hiring now — contacts, drawer, filters, Today, send path | **done** — contact discovery run over all 17 companies |
| — | Design pass (Claude Design MCP) | after real data is on screen |

Also outstanding, outside the queue: the remaining verify adapters (cswip, ampp, irata, winda, cisrs, electrical_dk), and watching the first unattended overnight run of the recheck cron.

Commit to main, two lines per step. Keep files small; one screen per file; no UI libraries. Design tokens live in `tailwind.config.js`.
