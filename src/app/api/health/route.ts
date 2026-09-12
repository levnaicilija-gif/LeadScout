import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';

/**
 * Which build is actually answering.
 *
 * Added because a production smoke run that started seconds after a push tested the previous
 * build and reported four failures against code that was correct — which is the worst kind of
 * red, because the honest response to it is to go looking for a bug that is not there.
 *
 * Vercel sets VERCEL_GIT_COMMIT_SHA at build time, so this is the commit that built the bundle
 * being served, not the commit that happens to be checked out somewhere else.
 */
export function GET() {
  return NextResponse.json({
    sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    env: process.env.VERCEL_ENV ?? 'local',
    at: new Date().toISOString(),
  });
}
