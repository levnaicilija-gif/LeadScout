# LeadScout — instructions for Claude Code

Read `LeadScout-build-prompt.txt` (full spec) and open `design/leadscout.html` + `design/leadscout-home.html` (the design to match exactly) before changing UI.

## The rule that overrides everything
Never fabricate. Every contact, email, phone, date or "verified" flag must come from a fetched page (stored with URL + time) or be shown as `pattern` / `unknown`. `src/lib/ai/claude.ts#appearsIn` is the check — keep using it. No Math.random() in data paths. Nothing is emailed except through `/api/outreach`, by a recruiter, to an address attached to a contact/company.

## State of the codebase (what works, what's next)
- Schema: `supabase/migrations/0001_schema.sql` — complete, with RLS and the sign-up trigger. Apply with `supabase db push` or in the SQL editor.
- Auth: Supabase email/password + magic link. `/login`, `/signup`, middleware protects `/app`.
- Radar job: `src/app/api/jobs/radar/route.ts` — fetch → Stage 1 extraction → validation → dedup → contacts/people. Link discovery is a heuristic; ADD per-source RSS/selector rules in `sources.crawl_prompt` or a `link_rule` column. Add `upsert` unique index on `contacts(lead_id,name)` and `leads(source_url)`.
- Verify: `/api/verify` extraction (Claude vision) + adapters `frosio`, `pcn`. TODO adapters: cswip, ampp, irata, winda, cisrs, electrical_dk (same interface, `src/lib/verify/adapters/types.ts`). Adapter selectors must be confirmed against the live sites on first run — record real selectors in each file.
- Anonymize: `/api/anonymize` parse → anonymize → bullets → score → ranking. TODO: React-PDF client PDF (`@react-pdf/renderer`) with the layout in `design/leadscout.html` (#pdfwrap) and a Claude PII review pass in addition to `piiRegexHits`.
- Lead tools: `/api/lead` jd / questions / score_pool / xray / draft / confirm / status. Outreach send: `/api/outreach` (Resend). TODO: Resend inbound webhook → `outreach.reply_at`.
- Screens: Today, Radar (+drawer), Verify, Pitch, Candidates, Settings, public `/v/[slug]`. Keep the design tokens in `tailwind.config.js`.
- Jobs: `vercel.json` crons (06:00 CET = 04:00 UTC). Worker (`worker/`) optional for long browser runs.
- Seeds: `npm run seed -- <workspace_id>` loads `seeds/*.csv`.

## Build order for remaining work
1. Apply schema, create a workspace via /signup, run seed, set env. Smoke-test Verify with a real FROSIO cert and a CV.
2. Fix adapter selectors on live sites; add remaining adapters.
3. Client PDF + PII model review; Preview button on Verify and Candidates.
4. Radar: per-source link rules for the top 20 sources; run job; review Stage 1 output quality on 50 articles; tune prompt.
5. Today: candidates-missing-documents item (campaigns), stat drill-downs, onboarding day gating.
6. Trade cards, glossary, screening-question storage on candidate.

Commit to main. Keep files small; one screen per file; no UI libraries.
