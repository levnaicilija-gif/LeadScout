import { supabaseServer } from '@/lib/supabase/server';
import { Help } from '@/components/Help';
import { LeadDrawer } from '@/components/LeadDrawer';
import { HiringNow, HiringHelp } from '@/components/HiringNow';
import { hasEmployerOverride, hasJobBoardFields } from '@/lib/schema-features';
export const dynamic = 'force-dynamic';
export default async function Radar({ searchParams }: { searchParams: { tab?: string; lead?: string; agencies?: string } }) {
  const sb = supabaseServer(); const tab = searchParams.tab === 'hiring' ? 'job_post' : 'won_work';
  const hiring = tab === 'job_post';
  // Migration 0012 may not be applied yet; naming a column that does not exist fails the whole
  // query, so the override is only asked for once it is there.
  const ovr = await hasEmployerOverride(sb);
  const coOverride = ovr ? ", employer_type_override, employer_type_set_at" : "";
  const boards0014 = await hasJobBoardFields(sb);
  const jpBoard = boards0014 ? ", poster_name, poster_type, is_secondary, duplicate_of" : "";

  // Hiring now reads job_posts directly: a posting on a company's own careers page has no lead
  // behind it, and inventing one to hang it off would be a lead nobody decided to create.
  const { data: postings } = hiring
    ? await sb.from('job_posts')
      .select(`id, company_id, title, role, location, country, trades, certs_required, rotation, contract_type, headcount, posted_at, first_seen_at, source_url, via${jpBoard}, companies!inner(name, employer_type, country, domain${coOverride})`)
      .eq('status', 'open').not('company_id', 'is', null)
      .order('posted_at', { ascending: false, nullsFirst: false }).order('first_seen_at', { ascending: false }).limit(400)
    : { data: null };
  const { count: boards } = hiring
    ? await sb.from('companies').select('id', { count: 'exact', head: true }).eq('careers_status', 'found')
    : { count: 0 };

  const { data: leads } = hiring ? { data: [] as any[] } : await sb.from('leads').select(`*, companies(name, employer_type, size_band${coOverride}), contacts(name, title, email_status, phone, linkedin_search_url, google_search_url), job_posts(role, headcount, certs_required, hiring_pressure, posted_at), lead_people(people(name, title, source))`).eq('kind', tab).not('status', 'in', '("stale","not_for_us")').order('fit_score', { ascending: false }).limit(50);
  // Postgres puts NULLs first on DESC, so without the not-null filter this picked an
  // uncrawled source and 'Last read' always said never, however often Radar had run.
  const { data: last } = await sb.from('sources').select('last_crawled_at').not('last_crawled_at', 'is', null).order('last_crawled_at', { ascending: false }).limit(1).maybeSingle();
  const { data: lastJobs } = await sb.from('companies').select('last_jobs_crawl_at').not('last_jobs_crawl_at', 'is', null).order('last_jobs_crawl_at', { ascending: false }).limit(1).maybeSingle();
  // Agencies are hidden unless asked for: a competitor's vacancy is not customer demand. The
  // count of what is hidden stays visible, so the market view is one click away.
  const showAgencies = searchParams.agencies === '1';
  const isAgency = (p: any) => (p.companies?.employer_type_override ?? p.companies?.employer_type) === 'staffing_agency';
  // A board advert that merely repeats a company's own careers page adds noise, not news.
  const notDuplicate = (p: any) => !p.duplicate_of;
  const shown = (postings ?? []).filter(notDuplicate);
  const duplicates = (postings ?? []).length - shown.length;
  const agencyPostings = shown.filter(isAgency);
  const hiringProps = {
    postings: (showAgencies ? shown : shown.filter((p: any) => !isAgency(p))) as any,
    crawledAt: lastJobs?.last_jobs_crawl_at,
    companiesWithBoards: boards ?? 0,
    showAgencies,
    hiddenAgencies: agencyPostings.length,
    duplicates,
  };

  const selected = leads?.find((l) => l.id === searchParams.lead) ?? null;
  return (<>
    <div className="flex items-baseline justify-between flex-wrap gap-x-3 gap-y-1 mb-3"><h1 className="font-display text-[26px] font-bold tracking-[-.4px]">Leads{hiring ? <HiringHelp /> : <Help title="What Radar is" intro="Reads your sources every morning and tells you which companies will need people, and who to talk to." rows={[['Won work', 'Company won a contract; the person quoted by name; when the work starts.'], ['Hiring now', 'Open trade postings, certs asked for, who to contact — from the posting, company site or attendee list.'], ['Verified', 'Source re-fetched each morning; Confirm records that you checked it. Outreach needs both.'], ['Never', 'Invents a name, an email, a phone or a job opening.']]} />}</h1><span className="text-ink3">{last?.last_crawled_at ? `Last read ${new Date(last.last_crawled_at).toLocaleString()}` : 'Not read yet'}{tab === 'job_post' ? ` · careers pages ${lastJobs?.last_jobs_crawl_at ? new Date(lastJobs.last_jobs_crawl_at).toLocaleDateString() : 'not crawled yet'}` : ''}</span></div>
    {/* v4 segmented control: the tab you are on is the navy one, not an underline. */}
    <div className="flex gap-1 bg-panel border border-line rounded-[12px] p-1 w-max mb-3.5">{[['won', 'Won work'], ['hiring', 'Hiring now']].map(([t, l]) => <a key={t} href={`?tab=${t}`} className={`px-3.5 py-2 rounded-[9px] font-medium ${(t === 'hiring') === (tab === 'job_post') ? 'bg-rail text-white' : 'text-ink2 hover:bg-line2'}`}>{l}</a>)}</div>
    {hiring ? <HiringNow {...hiringProps} /> : (
    <div className="bg-panel border border-line rounded-card overflow-auto max-h-[calc(100vh-190px)]"><table className="tbl w-full min-w-[1100px] border-collapse">
      <thead><tr><th>Company</th><th>{tab === 'won_work' ? 'Won' : 'Open roles'}</th><th>Decision-maker</th><th>Trades</th><th>{tab === 'won_work' ? 'Phase' : 'Pressure'}</th><th>Fit</th><th>Verified</th></tr></thead>
      <tbody>{(leads ?? []).map((l: any) => { const c = l.contacts?.[0]; const jp = l.job_posts?.[0]; return (
        <tr key={l.id} className={`cursor-pointer hover:bg-[#F9FAFB] ${selected?.id === l.id ? 'bg-accentsoft' : ''}`}>
          <td><a href={`?tab=${searchParams.tab ?? 'won'}&lead=${l.id}`} className="block"><div className="font-medium whitespace-nowrap">{l.companies?.name}</div><div className="text-ink3 text-[12px]">{l.project_location} · {l.companies?.employer_type?.replace('_', ' ')}{l.companies?.size_band ? ` · ${l.companies.size_band}` : ''}</div></a></td>
          <td>{tab === 'won_work' ? l.project_name : jp?.role}<div className="text-ink3 text-[12px]">{tab === 'won_work' ? [l.phase, l.project_value].filter(Boolean).join(' · ') : `${jp?.headcount ? `×${jp.headcount} · ` : ''}posted ${jp?.posted_at ?? '—'}`}</div></td>
          <td>{c ? <><div className="font-medium">{c.name} <a href={c.linkedin_search_url} target="_blank" rel="noopener" className="ml-1 inline-grid place-items-center w-5 h-5 border border-line rounded text-[10px] font-semibold text-ink2">in</a> <a href={c.google_search_url} target="_blank" rel="noopener" className="inline-grid place-items-center w-5 h-5 border border-line rounded text-[10px] font-semibold text-ink2">G</a></div><div className="text-ink3 text-[12px]">{c.title} · email {c.email_status}{c.phone ? ' · phone found' : ''}</div></> : <span className="text-ink3">— {l.lead_people?.length ? `${l.lead_people.length} from attendee list` : 'no named person'}</span>}</td>
          <td>{(l.trades_inferred ?? []).map((t: string) => <span key={t} className="inline-block text-[12px] px-2 py-0.5 rounded-md bg-line2 text-ink2 mr-1 mb-1">{t}</span>)}</td>
          <td>{tab === 'won_work' ? <span className="text-[13px]">{l.phase_start ?? l.phase ?? '—'}</span> : <span className={`st ${jp?.hiring_pressure === 'high' ? 'st-bad' : jp?.hiring_pressure === 'medium' ? 'st-warn' : ''}`}>{jp?.hiring_pressure ?? 'low'}</span>}</td>
          <td><span className="inline-flex items-center gap-2 font-semibold"><i className="inline-block w-[56px] h-[6px] rounded-full bg-line overflow-hidden"><i className="block h-full rounded-full bg-tool-leads" style={{ width: `${l.fit_score}%` }} /></i>{l.fit_score}</span></td>
          <td className="whitespace-nowrap"><span className={`badge ${l.source_fetch_status === 'live' ? (l.confirmed_at ? 'badge-ok' : 'badge-info') : 'badge-bad'}`}>{l.confirmed_at ? '✓ ' : ''}{l.source_fetch_status}{l.confirmed_at ? ' · confirmed' : ' · not confirmed'}</span><div className="text-[12px] mt-1"><a href={l.source_url} target="_blank" rel="noopener" className="text-accent font-medium">Open source</a></div></td>
        </tr>); })}
      {(leads ?? []).length === 0 && <tr><td colSpan={7} className="text-ink3 p-6">No leads yet. Radar reads your sources every morning at 06:00.</td></tr>}
      </tbody></table></div>)}
    {selected && <LeadDrawer lead={selected} />}
  </>);
}
