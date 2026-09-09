import { NextResponse } from 'next/server';
import { runLookup, ADAPTERS } from '@/lib/verify/adapters';
import { browserProvider } from '@/lib/browser';
export const maxDuration = 120;

/**
 * Run one verification adapter in the deployed runtime, without a file upload or a candidate.
 * The local equivalent is scripts/check-adapter.ts, but hosted-browser tokens are Vercel
 * Secrets that cannot be pulled, so the only way to test them is on the deployment itself.
 *
 * Nothing is written; this only reads an issuer's public register. Guarded by CRON_SECRET.
 *   POST /api/jobs/adapter-check?body=pcn&number=347534&method=Radiography
 */
const authorised = (req: Request) => {
  const s = process.env.CRON_SECRET;
  return !!s && (req.headers.get('x-cron-secret') === s || req.headers.get('authorization') === `Bearer ${s}`);
};

export const GET = (req: Request) => run(req);
export const POST = (req: Request) => run(req);

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const p = new URL(req.url).searchParams;
  const body = p.get('body') ?? '';
  if (!ADAPTERS[body]) return NextResponse.json({ error: `unknown body "${body}"`, known: Object.keys(ADAPTERS) }, { status: 400 });

  const started = Date.now();
  const r = await runLookup(body, {
    number: p.get('number') ?? undefined,
    holder: p.get('holder') ?? undefined,
    method: p.get('method') ?? undefined,
    level: p.get('level') ?? undefined,
    dob: p.get('dob') ?? undefined,
    credentialUrl: p.get('credentialUrl') ?? undefined,
  });

  return NextResponse.json({
    adapter: ADAPTERS[body].name,
    browser: browserProvider(),
    tookMs: Date.now() - started,
    result: r.result,
    validUntil: r.validUntil ?? null,
    holderOnSource: r.holderOnSource ?? null,
    screenshotBytes: r.screenshot?.length ?? 0,
    certificates: r.certificates ?? [],
    notes: r.notes ?? null,
  });
}
