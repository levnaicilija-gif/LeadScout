import Link from 'next/link';
import { currentUser, supabaseServer } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await currentUser(); if (!me) redirect('/login');
  const sb = supabaseServer();
  const [{ count: leads }, { count: cands }] = await Promise.all([sb.from('leads').select('id', { count: 'exact', head: true }).eq('status', 'new'), sb.from('candidates').select('id', { count: 'exact', head: true })]);
  const Item = ({ href, label, count, dim }: any) => <Link href={href} className={`flex justify-between items-center px-2.5 py-2 rounded ${dim ? 'text-raildim text-[13px]' : 'text-railink'} hover:bg-white/5`}>{label}<span className="text-[12px] text-raildim">{count}</span></Link>;
  return (<div className="grid grid-cols-[232px_1fr] min-h-screen">
    <nav className="bg-rail text-railink p-4 flex flex-col gap-0.5 sticky top-0 h-screen">
      <div className="flex items-center gap-2.5 px-2 pb-5"><span className="w-7 h-7 rounded-md bg-white text-rail grid place-items-center font-bold text-[13px]">L</span><b className="text-white">LeadScout</b></div>
      <Item href="/app/today" label="Today" /><Item href="/app/radar" label="Radar" count={leads ?? 0} /><Item href="/app/verify" label="Verify" count="drop" /><Item href="/app/pitch" label="Pitch" count="reverse" /><Item href="/app/candidates" label="Candidates" count={cands ?? 0} />
      <div className="flex-1" />
      {me.role === 'senior' && <Item href="/app/settings" label="Settings · Sources" count="senior" dim />}
      <div className="text-[12px] text-raildim px-2.5 pt-3 border-t border-white/10"><b className="block text-railink font-medium">{me.name ?? me.email}</b>Day {me.onboarding_day} · {me.role}</div>
    </nav>
    <main className="p-6 px-8 pb-20 min-w-0">{children}</main>
  </div>);
}
