import { runInBackground } from '@/lib/chain';
import { cronAuthorised } from '@/lib/jobs/cron-auth';
import { runCareersDiscoveryBatch } from '@/lib/jobs/careers-discovery-batch';
export const maxDuration = 300;

/** One batch of careers discovery (src/lib/jobs/careers-discovery-batch.ts). The tick runs it while companies are unchecked: src/lib/jobs/tick.ts. ?wait=1 returns the result. */
export const GET = (req: Request) => (cronAuthorised(req) ? runInBackground(req, () => runCareersDiscoveryBatch(req)) : runCareersDiscoveryBatch(req));
export const POST = GET;
