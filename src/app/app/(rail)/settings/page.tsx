import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { CandidateCountries } from '@/components/CandidateCountries';
import { hasCandidateCountries } from '@/lib/schema-features';
export const dynamic = 'force-dynamic';
export default async function Settings() {
  const me = await currentUser(); if (me?.role !== 'senior') redirect('/app/today');
  const sb = supabaseServer();
  const { data } = await sb.from('sources').select('*').order('type').order('name').limit(700);
  const ccReady = await hasCandidateCountries(sb);
  const { data: ws } = ccReady ? await sb.from('workspaces').select('candidate_countries').eq('id', me.workspace_id).maybeSingle() : { data: null as any };
  return (<><h1 className="font-display text-[26px] font-bold tracking-[-.4px] mb-1">Settings</h1>
    {ccReady && <CandidateCountries initial={ws?.candidate_countries ?? []} />}
    <h2 className="font-display text-[18px] font-bold mb-1">Sources</h2><p className="text-ink3 mb-3">What Radar reads every morning. Admin only. Seeded from seeds/sources.csv via <code>npm run seed</code>.</p>
    <div className="bg-panel border border-line rounded-card overflow-auto max-h-[75vh]"><table className="tbl w-full"><thead><tr><th>Source</th><th>Type</th><th>Region</th><th>Access</th><th>Last read</th><th>Enabled</th></tr></thead><tbody>{(data ?? []).map((s) => <tr key={s.id}><td><div className="font-medium">{s.name ?? s.url}</div><div className="text-ink3 text-[12px]">{s.url}</div></td><td>{s.type}</td><td>{s.region}</td><td>{s.paywalled ? 'Paywall · headlines' : 'Open'}</td><td>{s.last_crawled_at ? new Date(s.last_crawled_at).toLocaleString() : '—'}</td><td>{s.enabled ? 'On' : 'Off'}</td></tr>)}</tbody></table></div></>);
}
