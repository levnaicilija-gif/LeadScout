import Link from 'next/link';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { Help } from '@/components/Help';
export const dynamic = 'force-dynamic';
/** Today = six queries in a fixed priority order. Nothing generated, nothing sent. */
export default async function Today() {
  const me = await currentUser(); const sb = supabaseServer();
  const d = (n: number) => new Date(Date.now() + n * 86400000).toISOString();
  const [pending, noReply, newLeads, expiring, weekOk, weekBad, weekLeads, weekSends] = await Promise.all([
    sb.from('verifications').select('id, issuer_email_sent_at, documents(candidate_id, extracted, candidates(reference_code))').eq('result', 'pending'),
    sb.from('outreach').select('id, sent_at, leads(project_name, companies(name))').eq('status', 'sent').is('reply_at', null).lte('sent_at', d(-3)),
    sb.from('leads').select('id, kind, project_name, fit_score, trades_inferred, companies(name)').eq('status', 'new').gte('created_at', d(-7)).order('fit_score', { ascending: false }).limit(6),
    sb.from('verifications').select('id, valid_until, documents(cert_body, candidates(reference_code))').eq('result', 'valid').lte('valid_until', d(60).slice(0, 10)),
    sb.from('verifications').select('id', { count: 'exact', head: true }).eq('result', 'valid').gte('checked_at', d(-7)),
    sb.from('verifications').select('id', { count: 'exact', head: true }).in('result', ['invalid', 'not_found']).gte('checked_at', d(-7)),
    sb.from('contacts').select('lead_id', { count: 'exact', head: true }).gte('found_at', d(-7)),
    sb.from('anonymized_cvs').select('id', { count: 'exact', head: true }).eq('pii_check_passed', false),
  ]);
  type Item = { dot: string; title: string; sub: string; href: string; why: string; from: string };
  const items: Item[] = [];
  for (const v of pending.data ?? []) { const doc: any = v.documents; items.push({ dot: 'warn', title: `Issuer reply due on ${doc?.candidates?.reference_code}'s ${doc?.extracted?.issuer ?? 'welder'} cert`, sub: `Day ${Math.ceil((Date.now() - new Date(v.issuer_email_sent_at ?? Date.now()).getTime()) / 86400000)} · nudge if nothing today`, href: `/app/candidates?ref=${doc?.candidates?.reference_code}`, why: 'A pending cert blocks the candidate\'s pack.', from: 'verifications where result = pending' }); }
  for (const o of noReply.data ?? []) { const l: any = o.leads; items.push({ dot: '', title: `Follow up ${l?.companies?.name} — no reply since ${new Date(o.sent_at).toLocaleDateString()}`, sub: l?.project_name ?? '', href: `/app/radar`, why: 'Most replies come on the 2nd or 3rd touch.', from: 'outreach sent ≥ 3 days ago with no reply' }); }
  if ((newLeads.data ?? []).length) items.push({ dot: '', title: `Read ${newLeads.data!.length} new leads`, sub: newLeads.data!.map((l: any) => l.companies?.name).join(', '), href: '/app/radar', why: 'Contract awards are demand months before a job is posted.', from: 'leads with status = new in the last 7 days, by fit' });
  for (const v of expiring.data ?? []) { const doc: any = v.documents; items.push({ dot: 'warn', title: `${doc?.candidates?.reference_code} · ${doc?.cert_body} expires ${v.valid_until}`, sub: 'Renewal message drafted', href: `/app/candidates?ref=${doc?.candidates?.reference_code}`, why: 'An expired cert found on site means a sent-home worker.', from: 'verifications valid_until ≤ 60 days' }); }
  return (<>
    <div className="flex items-baseline justify-between mb-4"><h1 className="text-[22px] font-semibold">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}<Help title="What Today is" intro="Your day in order, built from the data. Nothing here is generated; nothing is sent." rows={[['Comes from', 'Radar leads, pending verifications, outreach without reply, expiring certificates.'], ['Never', 'Sends anything. Today proposes; you act.']]} /></h1><span className="text-ink3">{me?.name} · day {me?.onboarding_day}</span></div>
    <div className="grid grid-cols-[minmax(0,1fr)_280px] gap-4">
      <ol className="bg-panel border border-line rounded py-1">
        {items.length === 0 && <li className="p-5 text-ink3">Nothing yet. Drop a certificate or a CV into Verify, or wait for Radar at 06:00.</li>}
        {items.map((it, i) => <li key={i} className="grid grid-cols-[18px_1fr_auto] gap-3 items-start px-5 py-3.5 border-t border-line2 first:border-t-0"><span className={`w-2.5 h-2.5 rounded-full mt-1.5 ${it.dot === 'warn' ? 'bg-warn' : it.dot === 'bad' ? 'bg-bad' : 'bg-accent'}`} /><div><b className="font-medium block">{it.title}</b><small className="block text-ink3 text-[12px]">{it.sub}</small><details className="mt-1 text-[12px] text-ink2"><summary className="cursor-pointer text-ink3">Why · where from</summary>{it.why} <span className="text-ink3">· {it.from}</span></details></div><Link href={it.href} className="btn">Open</Link></li>)}
      </ol>
      <div className="flex flex-col gap-2.5">
        {[['ok', weekOk.count ?? 0, 'certificates verified this week'], ['bad', weekBad.count ?? 0, 'bad certificates caught before a client saw them'], ['', weekLeads.count ?? 0, 'leads with a sourced decision-maker'], ['', weekSends.count ?? 0, 'client CVs that failed the name check (must be 0)']].map(([c, n, l], i) => <div key={i} className="bg-panel border border-line rounded px-3.5 py-3 grid grid-cols-[auto_1fr] gap-3 items-center"><b className={`text-[26px] font-semibold leading-none min-w-[44px] ${c === 'ok' ? 'text-ok' : c === 'bad' ? 'text-bad' : ''}`}>{n as number}</b><span className="text-[12px] text-ink3">{l}</span></div>)}
      </div>
    </div>
  </>);
}
