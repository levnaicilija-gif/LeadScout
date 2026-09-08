import { supabaseServer } from '@/lib/supabase/server';
import { Help } from '@/components/Help';
import { LeadDrawer } from '@/components/LeadDrawer';
export const dynamic = 'force-dynamic';
export default async function Radar({ searchParams }: { searchParams: { tab?: string; lead?: string } }) {
  const sb = supabaseServer(); const tab = searchParams.tab === 'hiring' ? 'job_post' : 'won_work';
  const { data: leads } = await sb.from('leads').select('*, companies(name, employer_type, size_band), contacts(name, title, email_status, phone, linkedin_search_url, google_search_url), job_posts(role, headcount, certs_required, hiring_pressure, posted_at), lead_people(people(name, title, source))').eq('kind', tab).not('status', 'in', '("stale","not_for_us")').order('fit_score', { ascending: false }).limit(50);
  const { data: last } = await sb.from('sources').select('last_crawled_at').order('last_crawled_at', { ascending: false }).limit(1).maybeSingle();
  const selected = leads?.find((l) => l.id === searchParams.lead) ?? null;
  const Status = ({ s }: { s: string }) => <span className={`st text-[12px] ${s === 'live' ? 'st-ok' : s === 'stale' ? 'st-warn' : 'st-bad'}`}>{s}</span>;
  return (<>
    <div className="flex items-baseline justify-between mb-3"><h1 className="text-[22px] font-semibold">Radar<Help title="What Radar is" intro="Reads your sources every morning and tells you which companies will need people, and who to talk to." rows={[['Won work', 'Company won a contract; the person quoted by name; when the work starts.'], ['Hiring now', 'Open trade postings, certs asked for, who to contact — from the posting, company site or attendee list.'], ['Verified', 'Source re-fetched each morning; Confirm records that you checked it. Outreach needs both.'], ['Never', 'Invents a name, an email, a phone or a job opening.']]} /></h1><span className="text-ink3">Last read {last?.last_crawled_at ? new Date(last.last_crawled_at).toLocaleString() : 'never — run the Radar job'}</span></div>
    <div className="flex gap-0.5 border-b border-line mb-3">{[['won', 'Won work'], ['hiring', 'Hiring now']].map(([t, l]) => <a key={t} href={`?tab=${t}`} className={`px-3.5 py-2 -mb-px border-b-2 ${(t === 'hiring') === (tab === 'job_post') ? 'border-ink text-ink font-medium' : 'border-transparent text-ink3'}`}>{l}</a>)}</div>
    <div className="bg-panel border border-line rounded overflow-auto max-h-[calc(100vh-190px)]"><table className="tbl w-full min-w-[1100px] border-collapse">
      <thead><tr><th>Company</th><th>{tab === 'won_work' ? 'Won' : 'Open roles'}</th><th>Decision-maker</th><th>Trades</th><th>{tab === 'won_work' ? 'Phase' : 'Pressure'}</th><th>Fit</th><th>Verified</th></tr></thead>
      <tbody>{(leads ?? []).map((l: any) => { const c = l.contacts?.[0]; const jp = l.job_posts?.[0]; return (
        <tr key={l.id} className={`cursor-pointer hover:bg-[#F9FAFB] ${selected?.id === l.id ? 'bg-accentsoft' : ''}`}>
          <td><a href={`?tab=${searchParams.tab ?? 'won'}&lead=${l.id}`} className="block"><div className="font-medium whitespace-nowrap">{l.companies?.name}</div><div className="text-ink3 text-[12px]">{l.project_location} · {l.companies?.employer_type?.replace('_', ' ')}{l.companies?.size_band ? ` · ${l.companies.size_band}` : ''}</div></a></td>
          <td>{tab === 'won_work' ? l.project_name : jp?.role}<div className="text-ink3 text-[12px]">{tab === 'won_work' ? [l.phase, l.project_value].filter(Boolean).join(' · ') : `${jp?.headcount ? `×${jp.headcount} · ` : ''}posted ${jp?.posted_at ?? '—'}`}</div></td>
          <td>{c ? <><div className="font-medium">{c.name} <a href={c.linkedin_search_url} target="_blank" rel="noopener" className="ml-1 inline-grid place-items-center w-5 h-5 border border-line rounded text-[10px] font-semibold text-ink2">in</a> <a href={c.google_search_url} target="_blank" rel="noopener" className="inline-grid place-items-center w-5 h-5 border border-line rounded text-[10px] font-semibold text-ink2">G</a></div><div className="text-ink3 text-[12px]">{c.title} · email {c.email_status}{c.phone ? ' · phone found' : ''}</div></> : <span className="text-ink3">— {l.lead_people?.length ? `${l.lead_people.length} from attendee list` : 'no named person'}</span>}</td>
          <td>{(l.trades_inferred ?? []).map((t: string) => <span key={t} className="inline-block text-[12px] px-1.5 py-0.5 rounded bg-line2 text-ink2 mr-1 mb-1">{t}</span>)}</td>
          <td>{tab === 'won_work' ? <span className="text-[13px]">{l.phase_start ?? l.phase ?? '—'}</span> : <span className={`st ${jp?.hiring_pressure === 'high' ? 'st-bad' : jp?.hiring_pressure === 'medium' ? 'st-warn' : ''}`}>{jp?.hiring_pressure ?? 'low'}</span>}</td>
          <td><span className="inline-flex items-center gap-1.5"><i className="inline-block w-[46px] h-[5px] rounded bg-line overflow-hidden"><i className="block h-full bg-accent" style={{ width: `${l.fit_score}%` }} /></i>{l.fit_score}</span></td>
          <td><Status s={l.source_fetch_status} /><div className="text-[12px]"><a href={l.source_url} target="_blank" rel="noopener" className="text-accent">Open source</a> · {l.confirmed_at ? <span className="text-ok">✓ confirmed</span> : <span className="text-ink3">not confirmed</span>}</div></td>
        </tr>); })}
      {(leads ?? []).length === 0 && <tr><td colSpan={7} className="text-ink3 p-6">No leads yet. Run <code>POST /api/jobs/radar</code> with your cron secret, or add sources in Settings.</td></tr>}
      </tbody></table></div>
    {selected && <LeadDrawer lead={selected} />}
  </>);
}
