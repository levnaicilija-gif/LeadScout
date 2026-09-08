# LeadScout
Know who needs people before the job is posted. Recruitment workspace for industrial/offshore staffing: Radar (news + job boards → leads with sourced decision-makers), Today, Verify (certificate checks on issuer sites), CV anonymizer with client bullets and job scoring, Pitch (reverse placement).

## Run
1. `cp .env.example .env.local` and fill Supabase, Anthropic, Resend, CRON_SECRET.
2. Apply `supabase/migrations/0001_schema.sql` to your Supabase project (SQL editor or `supabase db push`).
3. `npm i && npx playwright install chromium && npm run dev`
4. Sign up at `/signup` (first user is senior). Copy your workspace id from the `workspaces` table and `npm run seed -- <workspace_id>`.
5. Trigger Radar once: `curl -X POST -H "x-cron-secret: $CRON_SECRET" localhost:3000/api/jobs/radar?limit=5`

## Security
No keys in source. Rotate the Google API key and Supabase anon key that were committed in the previous version of this repo.
