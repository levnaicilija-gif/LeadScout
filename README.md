# LeadScout
Know who needs people before the job is posted. Recruitment workspace for industrial/offshore staffing: Radar (news + job boards → leads with sourced decision-makers), Today, Verify (certificate checks on issuer sites), CV anonymizer with client bullets and job scoring, Pitch (reverse placement).

## Run
1. `cp .env.example .env.local` and fill Supabase, Anthropic, Resend, CRON_SECRET.
2. Apply `supabase/migrations/0001_schema.sql` to your Supabase project (SQL editor or `supabase db push`).
3. `npm i && npx playwright install chromium && npm run dev`
4. Sign up at `/signup` (first user is senior). Copy your workspace id from the `workspaces` table and `npm run seed -- <workspace_id>`.
5. Trigger Radar once: `curl -X POST -H "x-cron-secret: $CRON_SECRET" localhost:3000/api/jobs/radar?limit=5`

## Certificate verification adapters
One file per certifying body in `src/lib/verify/adapters/`, all implementing `Adapter`
(`src/lib/verify/adapters/types.ts`) and registered in `index.ts`. An adapter may only
report `valid`/`invalid` from values it actually read on the issuer's page; anything else
is `not_found` or `not_supported`, never a guess.

Test one against the live register without touching the database:

    npx tsx scripts/check-adapter.ts pcn --number 347534 --method Radiography
    npx tsx scripts/check-adapter.ts frosio --credentialUrl https://www.credential.net/<id>

All six registers below were checked live on 2026-09-08.

| body | register | needs | status |
|---|---|---|---|
| `pcn` | bindt.org PCN verification form | PCN number, or surname | working, **no browser** — confirmed live |
| `cswip` | cswip.com JSON API behind the verification form | certificate number **+ date of birth** | working, **no browser**; success payload shape still to confirm |
| `irata` | techconnect.irata.org/verify/tech | IRATA number (L/XXXXX) + surname | **needs a browser** — its API is reCAPTCHA-gated; result markup still to confirm |
| `frosio` | none public | Accredible credential URL/QR on the certificate | `not_supported` without that URL; **needs a browser** with one (JS-rendered) |
| `winda` | none public (login only) | — | `not_supported`, tells the recruiter what to do instead |
| `ampp` | none public (sign-in only) | — | `not_supported`, same |
| `cisrs` | none of its own; CSCS Smart Check covers it but is behind reCAPTCHA | — | `not_supported`, points at the card checker/app |
| `electrical_dk` | none — Denmark authorises companies, not individuals | — | `not_supported`, points at the company authorisation |
| `iso9606` (welders) | no public register | — | issuer email + test-report consistency, in `/api/verify` |

Five of the eight have no usable public register. FROSIO: frosio.no has no search, the FROSIO
Portal (apps.frosio.no) is login-only, and Accredible — which issues the certificates —
has no public search and needs an issuer API token, so the only honest check is the
credential URL/QR on the certificate or an email to frosio@frosio.no. WINDA: every page
redirects to a login and records are shared by the technician, not looked up. AMPP: the
certification search sits behind an account sign-in.

Where a success path is marked "still to confirm", the adapter has been driven against the
live site and its not-found path verified, but no real certificate was available to confirm
the fields a *hit* returns. Those adapters only report `valid` when the holder or number
actually appears in the fetched response; confirm and record the real shape on the first
real certificate (build order step 1).

To add an adapter: copy `pcn.ts`, confirm every selector against the live site, record the
confirmed URL/selectors in the file header with the date, and register it in `index.ts`.

## Browsers cost money — most pages do not need one

`src/lib/http.ts` is the cheap path: plain `fetch`, and it runs in any Vercel function.
`fetchPage` tries it first, falls back to the page's own RSS/Atom feed when the HTML comes
back as a JavaScript shell, and only then reaches for a browser. Every fetch reports `via`
(`http` | `rss` | `browser` | `none`), so a run says which sources cost money.

A browser is needed only for JavaScript-rendered pages, bot walls (HTTP 403) and
reCAPTCHA-gated APIs. `src/lib/browser.ts` is the single place that decides where one
comes from:

| env var | provider |
|---|---|
| `BROWSERLESS_TOKEN` (+ optional `BROWSERLESS_URL` for the region host) | browserless.io |
| `BROWSERBASE_API_KEY` | browserbase.com |
| neither | a local Playwright install, where one exists — never on Vercel |

With neither set nothing crashes: the affected source or adapter reports that it needs a
browser, and why.

Audit which sources are readable for free, without crawling them:

    curl -X POST -H "x-cron-secret: $CRON_SECRET" \
      "$APP_URL/api/jobs/radar?limit=20&audit=1"

Add `&only=<url substring>` to aim a run at particular sources.

## The daily run

Radar chunks itself: each invocation crawls `batch` sources (default 5) starting at
`cursor`, then dispatches the next batch to a fresh invocation and returns. A Vercel
function has 300 s and a 20-source crawl does not fit in one. `batchesLeft` caps the chain,
`chain=0` disables it, and every batch logs one line:

    [radar] cursor=0 batch=5 sources=5 articles=22 leads=1 rejected=21 next=5

Useful parameters: `only=` (comma-separated url substrings) aims a run at particular
sources; `audit=1` reports how each source can be read without crawling it.

### Per-source link rules

Most sites are handled by the generic article-shape heuristic. The ones that are not get a
rule in `src/lib/source-rules.ts`, or a per-workspace override in `sources.link_rule`
(migration 0005) — a bare regex for the article pathname, or JSON
`{index:...,pattern:...,browser:true}`. A source that reads fine but yields no
article-shaped links also gets one browser attempt before being written off.

## Security
No keys in source. Rotate the Google API key and Supabase anon key that were committed in the previous version of this repo.
