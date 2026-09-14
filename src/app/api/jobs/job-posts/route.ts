import { runInBackground } from '@/lib/chain';
import { cronAuthorised } from '@/lib/jobs/cron-auth';
import { runJobPostsBatch } from '@/lib/jobs/job-posts-batch';
export const maxDuration = 300;

/** One batch of the job-post crawl (src/lib/jobs/job-posts-batch.ts). The daily crawl is the tick's: src/lib/jobs/tick.ts. ?wait=1 returns the result. */
export const GET = (req: Request) => (cronAuthorised(req) ? runInBackground(req, () => runJobPostsBatch(req)) : runJobPostsBatch(req));
export const POST = GET;
