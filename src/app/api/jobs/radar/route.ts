import { runInBackground } from '@/lib/chain';
import { cronAuthorised } from '@/lib/jobs/cron-auth';
import { runRadarBatch } from '@/lib/jobs/radar-batch';
export const maxDuration = 300;

/** One Radar batch (src/lib/jobs/radar-batch.ts). The daily run is the tick's: src/lib/jobs/tick.ts. ?wait=1 returns the result. */
export const GET = (req: Request) => (cronAuthorised(req) ? runInBackground(req, () => runRadarBatch(req)) : runRadarBatch(req));
export const POST = GET;
