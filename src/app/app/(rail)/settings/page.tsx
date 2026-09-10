import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
export const dynamic = 'force-dynamic';
export default async function Settings() {
  const me = await currentUser(); if (me?.role !== 'senior') redirect('/app/today');
  const { data } = await supabaseServer().from('sources').select('*').order('type').order('name').limit(700);
  return (<><h1 className="text-[22px] font-semibold mb-1">Settings · Sources</h1><p className="text-ink3 mb-3">What Radar reads every morning. Admin only. Seeded from seeds/sources.csv via <code>npm run seed</code>.</p>
    <div className="bg-panel border border-line rounded overflow-auto max-h-[75vh]"><table className="tbl w-full"><thead><tr><th>Source</th><th>Type</th><th>Region</th><th>Access</th><th>Last read</th><th>Enabled</th></tr></thead><tbody>{(data ?? []).map((s) => <tr key={s.id}><td><div className="font-medium">{s.name ?? s.url}</div><div className="text-ink3 text-[12px]">{s.url}</div></td><td>{s.type}</td><td>{s.region}</td><td>{s.paywalled ? 'Paywall · headlines' : 'Open'}</td><td>{s.last_crawled_at ? new Date(s.last_crawled_at).toLocaleString() : '—'}</td><td>{s.enabled ? 'On' : 'Off'}</td></tr>)}</tbody></table></div></>);
}
