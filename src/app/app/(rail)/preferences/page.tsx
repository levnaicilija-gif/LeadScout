import { currentUser, supabaseAdmin, supabaseServer } from '@/lib/supabase/server';
import { canFollowAll } from '@/lib/industry-follow';
import { hasIndustryFollow } from '@/lib/schema-features';
import { followOptionCounts } from '@/lib/industry-counts';
import { INDUSTRY_LABEL, FOLLOW_OPTIONS } from '@/lib/industry';
import { IndustryOnboarding } from '@/components/IndustryOnboarding';
export const dynamic = 'force-dynamic';

/**
 * Preferences — for everyone, not only seniors (item 18 part 3). The industries this person follows, changeable at
 * any time within their entitlement. The choice filters the default view of Leads, Hiring now and Today; it hides
 * nothing for good, and every one of those screens has a one-click switch to all industries.
 */
export default async function Preferences({ searchParams }: { searchParams: { saved?: string } }) {
  const me = await currentUser();
  const admin = supabaseAdmin();
  if (!(await hasIndustryFollow(admin))) {
    return (<><h1 className="font-display text-[26px] font-bold tracking-[-.4px] mb-2">Preferences</h1><p className="text-ink3">Following industries arrives with migration 0032, which has not been applied yet.</p></>);
  }
  const { data: row, error } = await admin.from('users').select('industry_follow, industry_limit, industry_follow_set_at, industry_follow_set_by').eq('id', me!.id).single();
  if (error || !row) return <p className="text-bad">Your preferences could not be read: {error?.message ?? 'no row'}.</p>;
  const options = await followOptionCounts(supabaseServer());
  const follow = (row.industry_follow ?? []) as string[];
  const label = (id: string) => (id === 'all' ? 'All industries' : FOLLOW_OPTIONS.find((o) => o.id === id)?.label ?? INDUSTRY_LABEL[id as keyof typeof INDUSTRY_LABEL] ?? id);
  const bySomeoneElse = row.industry_follow_set_by && row.industry_follow_set_by !== me!.id;

  return (<>
    <h1 className="font-display text-[26px] font-bold tracking-[-.4px] mb-1">Preferences</h1>
    <p className="text-ink3 mb-4 max-w-[70ch]">The industries you follow open first on Leads, Hiring now and Today. Nothing else is hidden: each of those screens switches to all industries in one click.</p>
    {searchParams.saved && <p data-preferences-saved className="text-ok text-[13px] mb-3">Saved.</p>}
    <div data-following className="text-[13px] mb-2">You follow: <b>{follow.length ? follow.map(label).join(', ') : 'nothing chosen yet'}</b>{row.industry_follow_set_at ? <span className="text-ink3"> · set {new Date(row.industry_follow_set_at).toLocaleDateString()}{bySomeoneElse ? ' by a senior in your workspace' : ''}</span> : null}</div>
    <div className="text-[13px] text-ink3 mb-2">{row.industry_limit != null ? `Your account may follow up to ${row.industry_limit}.` : 'Your account may follow any number, or all industries.'}</div>
    <IndustryOnboarding options={options} limit={row.industry_limit} canFollowAll={canFollowAll(row.industry_limit)} initial={follow} saveLabel="Save" after="/app/preferences?saved=1" />
  </>);
}
