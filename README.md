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

| body | register | status |
|---|---|---|
| `pcn` | bindt.org PCN verification form | working — confirmed live 2026-09-08 |
| `frosio` | none public | `not_supported` unless the certificate carries an Accredible credential URL |
| `cswip` `ampp` `irata` `winda` `cisrs` `electrical_dk` | — | not written yet |
| `iso9606` (welders) | no public register | issuer email + test-report consistency, in `/api/verify` |

FROSIO has no public register: frosio.no has no search, the FROSIO Portal
(apps.frosio.no) is login-only, and Accredible — which issues the certificates — has no
public search and needs an issuer API token. The only honest check is the credential
URL/QR printed on the certificate itself, or an email to frosio@frosio.no.

To add an adapter: copy `pcn.ts`, confirm every selector against the live site, record the
confirmed URL/selectors in the file header with the date, and register it in `index.ts`.

## Security
No keys in source. Rotate the Google API key and Supabase anon key that were committed in the previous version of this repo.
