import Link from 'next/link';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { Help } from '@/components/Help';
import { todayItems, whenLabel } from '@/lib/today';
import { planFor, needsReview } from '@/lib/onboarding';
export const dynamic = 'force-dynamic';
/** Today = six queries in a fixed priority order. Nothing generated, nothing sent. */
export default async function Today() {
  const me = await currentUser(); const sb = supabaseServer();
  const d = (n: number) => new Date(Date.now() + n * 86400000).toISOString();
  // The list itself is shared with Home, so the two can never disagree about what the day holds.
  const [items, weekOk, weekBad, weekLeads, weekSends] = await Promise.all([
    todayItems(sb),
    sb.from('verifications').select('id', { count: 'exact', head: true }).eq('result', 'valid').gte('checked_at', d(-7)),
    sb.from('verifications').select('id', { count: 'exact', head: true }).in('result', ['invalid', 'not_found']).gte('checked_at', d(-7)),
    sb.from('contacts').select('lead_id', { count: 'exact', head: true }).gte('found_at', d(-7)),
    sb.from('anonymized_cvs').select('id', { count: 'exact', head: true }).eq('pii_check_passed', false),
  ]);
  // The day's goal, for anyone still inside their first fortnight. A senior never sees it.
  const plan = planFor(me?.onboarding_day);
  const onPlan = me?.role !== 'senior' && (me?.onboarding_day ?? 99) <= 10;

  return (<>
    {onPlan && (
      <div className="bg-panel border border-line rounded px-4 py-3 mb-3">
        <div className="text-[12px] text-ink3">Day {plan.day} of your first fortnight</div>
        <b className="text-[15px] font-semibold">{plan.goal}</b>
        {needsReview(me) && <div className="text-[12px] text-warn mt-1">Outreach and packs you send today go to a senior for review before they leave.</div>}
      </div>
    )}
    <div className="flex items-baseline justify-between mb-4"><h1 className="text-[22px] font-semibold">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}<Help title="What Today is" intro="Your day in order, built from the data. Nothing here is generated; nothing is sent." rows={[['Comes from', 'Radar leads, pending verifications, outreach without reply, expiring certificates.'], ['Never', 'Sends anything. Today proposes; you act.']]} /></h1><span className="text-ink3">{me?.name} · day {me?.onboarding_day}</span></div>
    <div className="grid grid-cols-[minmax(0,1fr)_280px] gap-4">
      <ol className="bg-panel border border-line rounded py-1">
        {items.length === 0 && <li className="p-5 text-ink3">Nothing yet. Drop a certificate or a CV into Verify, or wait for Radar at 06:00.</li>}
        {items.map((it, i) => <li key={i} className="grid grid-cols-[64px_18px_1fr_auto] gap-3 items-start px-5 py-3.5 border-t border-line2 first:border-t-0"><span className="text-ink3 text-[12px] whitespace-nowrap mt-0.5">{i + 1} · {whenLabel(it, i)}</span><span className={`w-2.5 h-2.5 rounded-full mt-1.5 ${it.dot === 'warn' ? 'bg-warn' : it.dot === 'bad' ? 'bg-bad' : 'bg-accent'}`} /><div><b className="font-medium block">{it.title}</b><small className="block text-ink3 text-[12px]">{it.sub}</small><details className="mt-1 text-[12px] text-ink2"><summary className="cursor-pointer text-ink3">Why · where from</summary>{it.why} <span className="text-ink3">· {it.from}</span></details></div><Link href={it.href} className="btn">Open</Link></li>)}
      </ol>
      <div className="flex flex-col gap-2.5">
        {[['ok', weekOk.count ?? 0, 'certificates verified this week'], ['bad', weekBad.count ?? 0, 'bad certificates caught before a client saw them'], ['', weekLeads.count ?? 0, 'leads with a sourced decision-maker'], ['', weekSends.count ?? 0, 'client CVs that failed the name check (must be 0)']].map(([c, n, l], i) => <div key={i} className="bg-panel border border-line rounded px-3.5 py-3 grid grid-cols-[auto_1fr] gap-3 items-center"><b className={`text-[26px] font-semibold leading-none min-w-[44px] ${c === 'ok' ? 'text-ok' : c === 'bad' ? 'text-bad' : ''}`}>{n as number}</b><span className="text-[12px] text-ink3">{l}</span></div>)}
      </div>
    </div>
  </>);
}
