import { currentUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

/**
 * Auth only. The chrome lives one level down: the working screens keep the rail from
 * design/leadscout.html, and Home has the top bar from design/leadscout-home-v2.html, so
 * neither can inherit the other's.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await currentUser();
  if (!me) redirect('/login');
  return <>{children}</>;
}
