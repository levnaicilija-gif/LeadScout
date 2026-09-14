import { redirect } from 'next/navigation';
import { requireUser, supabaseAdmin, supabaseServer } from '@/lib/supabase/server';
import { canFollowAll } from '@/lib/industry-follow';
import { hasIndustryFollow } from '@/lib/schema-features';
import { followOptionCounts } from '@/lib/industry-counts';
import { Logo } from '@/components/Logo';
import { IndustryOnboarding, type OnboardingOption } from '@/components/IndustryOnboarding';
export const dynamic = 'force-dynamic';

/**
 * First sign-in: choose the industries you work in, before any other screen (item 18 part 3).
 *
 * Every screen under /app sends a person here while their users.industry_follow is empty (0032); nothing here can
 * be skipped. Beside each option is what is on file today — open won-work leads and companies hiring — so a choice
 * is never made blind and nobody lands on an empty screen they did not expect. "All industries" is offered only
 * when the account's entitlement has no cap.
 */
export default async function Onboarding() {
  const me = await requireUser();
  const admin = supabaseAdmin();
  if (!(await hasIndustryFollow(admin))) redirect('/app');
  const { data: row } = await admin.from('users').select('industry_follow, industry_limit').eq('id', me.id).single();
  if (row?.industry_follow) redirect('/app');

  // What is on file today, per option, as this person's own workspace sees it.
  const options: OnboardingOption[] = await followOptionCounts(supabaseServer());

  return (
    <main className="min-h-screen bg-canvas px-4 py-8 sm:py-12">
      <div className="max-w-[760px] mx-auto">
        <Logo size="sm" />
        <h1 className="font-display text-[26px] font-bold tracking-[-.4px] mt-6">Which industries do you work in?</h1>
        <p className="text-ink2 mt-2 max-w-[62ch]">Leads, Hiring now and Today will open on these. Nothing else is hidden — every screen has a one-click switch to all industries, and you can change this in Preferences at any time.</p>
        <IndustryOnboarding options={options} limit={row?.industry_limit ?? null} canFollowAll={canFollowAll(row?.industry_limit ?? null)} />
      </div>
    </main>
  );
}
