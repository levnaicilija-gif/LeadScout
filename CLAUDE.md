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

## State of the codebase
- **Migrations 0001–0013 applied.** 0011 source tiers + `radar_runs`, 0012 employer-type override, 0013 right to work + `workspaces.candidate_countries`.
- **Radar**: 600 sources classified by Haiku into priority (44) / standard (189) / off (366, reason stored). Priority daily, everything on Sundays — same cron. `repair-sources` finds a newsroom again when a URL rots and follows a rebrand (Wood → woodgroup.com). 29 won-work leads.
- **Hiring now**: careers/ATS discovery over the company universe — 226 boards found, **208 companies still queued** (runs overnight off the recheck cron). 20 ATS vendors; Workday needs a POST. Job-post crawl: fingerprint → Haiku titles (also maps trades from the source language) → Sonnet bodies, €2/day cap. 32 open postings, grouped one row per company, sorted by pressure, agencies hidden by default.
- **Verify**: one drop zone, recognises by content. CV card streams Read → Anonymized → Bullets → PDF → Questions. Questions are match-aware when a job is selected. Adapters `frosio`, `pcn` live; **cswip, ampp, irata, winda, cisrs, electrical_dk still TODO** (`src/lib/verify/adapters/types.ts`) — confirm selectors against the live site and record them in the file.
- **Right to work**: `src/lib/right-to-work.ts` is the single rule. Blocker keyed on the **lead's** country. EU job → EU/EEA passport. UK job → an EU passport is *not* enough. `unknown` never passes. LinkedIn search countries follow the job; never Serbia by default.
- **Screens**: Home (day < 8 lands here, logo always goes Home), Today, Leads (Won work / Hiring now), Verify, Pitch, Candidates, Settings, public `/v/[slug]`.
- **Chains**: every chained job dispatches the next batch *before* doing its own work. Doing it after means one 300 s timeout kills the whole run — this has bitten Radar, discovery and the job crawl.
- **`supabaseAdmin` sends `cache: 'no-store'`.** Next's Data Cache froze a query result across deploys and `/v/<slug>` served "Not found" for a candidate that existed.

## What is next
1. Remaining verify adapters (cswip, ampp, irata, winda, cisrs, electrical_dk).
2. Finish careers discovery for the 208 queued companies; watch the first unattended overnight run.
3. Per-company cap or grouping refinement on Hiring now if one employer still dominates.
4. Today: candidates-missing-documents item (campaigns), stat drill-downs, onboarding day gating.
5. Trade cards, glossary, screening-question storage on the candidate.
6. Resend inbound webhook → `outreach.reply_at`.

Commit to main, two lines per step. Keep files small; one screen per file; no UI libraries. Design tokens live in `tailwind.config.js`.
