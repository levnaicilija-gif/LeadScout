import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/supabase/server';

/**
 * Where /app lands.
 *
 * In the first week the job itself is the thing being learned, so Home — one card per part of
 * it, with what each one is for written on the card. After that the recruiter knows the shape
 * of the work and wants the queue: Today. The logo goes Home from anywhere, either way.
 */
export default async function AppEntry() {
  const me = await currentUser();
  redirect((me?.onboarding_day ?? 99) < 8 ? '/app/home' : '/app/today');
}
