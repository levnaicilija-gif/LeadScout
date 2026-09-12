import Link from 'next/link';
import { currentUser, supabaseServer } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { SignOut } from '@/components/SignOut';
import { canSee, planFor, opensOn, type Screen } from '@/lib/onboarding';
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await currentUser(); if (!me) redirect('/login');
  const sb = supabaseServer();
  const [{ count: leads }, { count: cands }, { count: camps }] = await Promise.all([sb.from('leads').select('id', { count: 'exact', head: true }).eq('status', 'new'), sb.from('candidates').select('id', { count: 'exact', head: true }), sb.from('campaigns').select('id', { count: 'exact', head: true }).eq('status', 'active')]);
  const plan = planFor(me.onboarding_day);
  // A screen that has not opened yet is shown, not hidden: a new recruiter should be able to see
  // the shape of the job and when each part of it starts. Hiding it would make the plan a
  // mystery rather than a plan.
  const Item = ({ href, label, count, screen }: any) => {
    const open = !screen || canSee(screen as Screen, me);
    if (open) return <Link href={href} className="flex justify-between items-center px-2.5 py-2 rounded text-railink hover:bg-white/5">{label}<span className="text-[12px] text-raildim">{count}</span></Link>;
    return <span className="flex justify-between items-center px-2.5 py-2 rounded text-raildim cursor-default" title={`Opens on day ${opensOn(screen as Screen)}`}>{label}<span className="text-[12px] text-raildim">day {opensOn(screen as Screen)}</span></span>;
  };
  return (<div className="grid grid-cols-[232px_1fr] min-h-screen">
    <nav className="bg-rail text-railink p-4 flex flex-col gap-0.5 sticky top-0 h-screen">
      {/* The logo always goes Home. */}
      <Link href="/app/home" className="flex items-center gap-2.5 px-2 pb-5"><span className="w-7 h-7 rounded-md bg-white text-rail grid place-items-center font-bold text-[13px]">L</span><b className="text-white">LeadScout</b></Link>
      <Item href="/app/today" label="Today" screen="today" /><Item href="/app/radar" label="Leads" count={leads ?? 0} screen="radar" /><Item href="/app/verify" label="Verify" count="drop" screen="verify" /><Item href="/app/pitch" label="Pitch" count="reverse" screen="pitch" /><Item href="/app/candidates" label="Candidates" count={cands ?? 0} screen="candidates" /><Item href="/app/campaigns" label="Campaigns" count={camps ?? 0} screen="campaigns" />
      <div className="flex-1" />
      {me.role === 'senior' && <Item href="/app/settings" label="Settings · Sources" count="senior" />}
      <div className="text-[12px] text-raildim px-2.5 pt-3 border-t border-white/10"><b className="block text-railink font-medium">{me.name ?? me.email}</b>Day {me.onboarding_day} · {me.role}{me.role !== 'senior' && (me.onboarding_day ?? 99) <= 10 && <span className="block mt-1 text-railink">{plan.goal}</span>}<div className="mt-1.5 -mx-2.5"><SignOut /></div></div>
    </nav>
    <main className="p-6 px-8 pb-20 min-w-0">{children}</main>
  </div>);
}
