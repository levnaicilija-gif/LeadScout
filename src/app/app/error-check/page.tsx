import { notFound } from 'next/navigation';
import { requireUser, supabaseAdmin } from '@/lib/supabase/server';
export const dynamic = 'force-dynamic';

/**
 * A screen that fails on purpose, so the error page (src/app/error.tsx) can be checked on production: the sign-in outage
 * that first showed the bare "Application error" page cannot be summoned on demand. It throws inside the /app layout,
 * where requireUser runs, and goes through the same boundary. Only an account in a workspace marked is_test ever sees
 * it fail — anyone else gets a 404 — so no recruiter meets it. scripts/error-boundary-probe.ts uses it.
 */
export default async function ErrorCheck() {
  const me = await requireUser();
  const { data: ws } = await supabaseAdmin().from('workspaces').select('is_test').eq('id', me.workspace_id).maybeSingle();
  if (!ws?.is_test) notFound();
  throw new Error('error-check: a deliberate failure, so the error page can be checked on screen');
}
