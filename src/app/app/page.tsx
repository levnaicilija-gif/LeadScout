import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/supabase/server';
import { mustChooseIndustries } from '@/lib/industry-follow';

/**
 * Where /app lands.
 *
 * A new account first chooses its industries (item 18, /app/onboarding). In the first week the job itself is the
 * thing being learned, so Home — one card per part of it, with what each one is for written on the card. After
 * that the recruiter knows the shape of the work and wants the queue: Today. The logo goes Home from anywhere.
 */
export default async function AppEntry() {
  const me = await currentUser();
  if (mustChooseIndustries(me)) redirect('/app/onboarding');
  redirect((me?.onboarding_day ?? 99) < 8 ? '/app/home' : '/app/today');
}
