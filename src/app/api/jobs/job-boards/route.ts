import { runInBackground } from '@/lib/chain';
import { cronAuthorised } from '@/lib/jobs/cron-auth';
import { runJobBoardsBatch } from '@/lib/jobs/job-boards-batch';
export const maxDuration = 300;

/** One job-board batch (src/lib/jobs/job-boards-batch.ts). The daily run is the tick's: src/lib/jobs/tick.ts. ?wait=1 returns the result. */
export const GET = (req: Request) => (cronAuthorised(req) ? runInBackground(req, () => runJobBoardsBatch(req)) : runJobBoardsBatch(req));
export const POST = GET;
