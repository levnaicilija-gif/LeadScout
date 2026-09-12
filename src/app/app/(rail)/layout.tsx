import Link from 'next/link';
import { currentUser, supabaseServer } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { SignOut } from '@/components/SignOut';
import { Logo } from '@/components/Logo';
import { DOT } from '@/lib/tool-colour';
import { canSee, planFor, opensOn, type Screen } from '@/lib/onboarding';

/**
 * The working chrome — design/leadscout-design-v4.html, kept as a rail.
 *
 * v4 draws a top nav, but the rail carries two things a bar cannot: the live count beside each
 * screen, and the day a screen opens for someone still in their first fortnight. Restyling is
 * not a reason to lose either, so the rail keeps its shape and takes v4's language instead —
 * new mark, rounded items, and each screen marked with its own colour so the dot on the rail,
 * the tile on Home and the stripe on the card are recognisably the same tool.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await currentUser(); if (!me) redirect('/login');
  const sb = supabaseServer();
  const [{ count: leads }, { count: cands }, { count: camps }] = await Promise.all([sb.from('leads').select('id', { count: 'exact', head: true }).eq('status', 'new'), sb.from('candidates').select('id', { count: 'exact', head: true }), sb.from('campaigns').select('id', { count: 'exact', head: true }).eq('status', 'active')]);
  const plan = planFor(me.onboarding_day);
  // A screen that has not opened yet is shown, not hidden: a new recruiter should be able to see
  // the shape of the job and when each part of it starts. Hiding it would make the plan a
  // mystery rather than a plan.
  const Item = ({ href, label, count, screen, tool }: any) => {
    const open = !screen || canSee(screen as Screen, me);
    const dot = <span className={`w-2 h-2 rounded-full shrink-0 ${open ? DOT[tool as keyof typeof DOT] : 'bg-white/15'}`} />;
    if (open) return <Link href={href} className="flex items-center gap-2.5 px-2.5 py-2 rounded text-railink hover:bg-white/[.07] transition-colors shrink-0 whitespace-nowrap">{dot}<span className="lg:flex-1">{label}</span><span className="text-[12px] text-raildim">{count}</span></Link>;
    return <span className="flex items-center gap-2.5 px-2.5 py-2 rounded text-raildim cursor-default shrink-0 whitespace-nowrap" title={`Opens on day ${opensOn(screen as Screen)}`}>{dot}<span className="lg:flex-1">{label}</span><span className="text-[12px] text-raildim">day {opensOn(screen as Screen)}</span></span>;
  };
  // Below lg the rail lies down and becomes a scrolling bar: at 390px a 232px column leaves
  // 158px for the screen, which is not a narrow layout but a broken one.
  return (<div className="grid grid-cols-1 lg:grid-cols-[232px_1fr] min-h-screen">
    <nav className="bg-rail text-railink p-3 lg:p-4 flex lg:flex-col gap-0.5 items-center lg:items-stretch overflow-x-auto lg:overflow-visible lg:sticky lg:top-0 lg:h-screen">
      {/* The logo always goes Home. */}
      <Link href="/app/home" className="px-2 shrink-0 lg:pb-5 lg:pt-1"><Logo light size="sm" /></Link>
      <Item href="/app/today" label="Today" screen="today" tool="today" /><Item href="/app/radar" label="Leads" count={leads ?? 0} screen="radar" tool="leads" /><Item href="/app/verify" label="Verify" count="drop" screen="verify" tool="verify" /><Item href="/app/pitch" label="Pitch" count="reverse" screen="pitch" tool="pitch" /><Item href="/app/candidates" label="Candidates" count={cands ?? 0} screen="candidates" tool="cand" /><Item href="/app/campaigns" label="Campaigns" count={camps ?? 0} screen="campaigns" tool="cand" />
      <div className="hidden lg:block flex-1" />
      {me.role === 'senior' && <Item href="/app/settings" label="Settings · Sources" count="senior" tool="set" />}
      <div className="text-[12px] text-raildim px-2.5 shrink-0 whitespace-nowrap lg:pt-3 lg:border-t lg:border-white/10"><b className="block text-railink font-medium">{me.name ?? me.email}</b>Day {me.onboarding_day} · {me.role}{me.role !== 'senior' && (me.onboarding_day ?? 99) <= 10 && <span className="hidden lg:block mt-1 text-railink">{plan.goal}</span>}<div className="mt-1.5 -mx-2.5"><SignOut /></div></div>
    </nav>
    <main className="p-4 sm:p-6 sm:px-8 pb-20 min-w-0">{children}</main>
  </div>);
}
