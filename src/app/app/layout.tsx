import { requireUser } from '@/lib/supabase/server';
import { HydratedMark } from '@/components/HydratedMark';
import { CandidateDrop } from '@/components/CandidateDrop';
import { canSee } from '@/lib/onboarding';

/**
 * Auth only. The chrome lives one level down: the working screens keep the rail from
 * design/leadscout.html, and Home has the top bar from design/leadscout-home-v2.html, so
 * neither can inherit the other's. HydratedMark tells scripts when a screen can be tapped.
 *
 * Item 24: the CV drop zone lives here so it is on every screen — Home and the rail alike — for anyone whose Candidates
 * screen is open.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await requireUser();
  return <>{children}{canSee('candidates', me) && <CandidateDrop />}<HydratedMark /></>;
}
