/**
 * Who may start a job: Vercel cron (a GET with `Authorization: Bearer <CRON_SECRET>`), Supabase pg_cron and
 * scripts (`x-cron-secret`). Accept both, on both verbs, or a scheduled run silently 405s or 401s.
 */
export const cronAuthorised = (req: Request) => {
  const s = process.env.CRON_SECRET;
  return !!s && (req.headers.get('x-cron-secret') === s || req.headers.get('authorization') === `Bearer ${s}`);
};
