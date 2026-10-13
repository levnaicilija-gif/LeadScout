import { runInBackground } from '@/lib/chain';
import { cronAuthorised } from '@/lib/jobs/cron-auth';
import { runTenderChainBatch } from '@/lib/jobs/tender-chain-batch';
export const maxDuration = 300;

/** One batch of the tender chain (src/lib/jobs/tender-chain.ts). The tick runs it while the switch is on and the slice has room. ?wait=1 returns the result. */
export const GET = (req: Request) => (cronAuthorised(req) ? runInBackground(req, () => runTenderChainBatch(req)) : runTenderChainBatch(req));
export const POST = GET;
