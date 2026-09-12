'use client';
import { useState } from 'react';
const T = ['painter', 'blaster', 'welder', 'pipefitter', 'fitter', 'ndt', 'rope access', 'wind', 'electrician', 'scaffold'];
export function PitchClient({ candidates, leads }: { candidates: any[]; leads: any[] }) {
  const [cid, setCid] = useState(candidates[0]?.id ?? ''); const [matches, setMatches] = useState<any[]>([]);
  const c = candidates.find((x) => x.id === cid);
  const match = () => {
    if (!c) return; const trade = (c.trade ?? '').toLowerCase(); const projects: any[] = c.profile?.projects ?? [];
    const scored = leads.map((l) => {
      const t = (l.trades_inferred ?? []).some((x: string) => T.some((k) => trade.includes(k) && x.toLowerCase().includes(k))) ? 1 : 0;
      const site = projects.some((p) => (l.project_location ?? '').toLowerCase().includes((p.country ?? '').toLowerCase()) && p.country) ? 1 : 0;
      const e = l.companies?.employer_type === 'end_client' || l.companies?.employer_type === 'epc_contractor' ? 1 : 0.4;
      return { ...l, score: Math.round((t * 0.5 + site * 0.3 + e * 0.2) * 100) };
    }).filter((l) => l.score > 20).sort((a, b) => b.score - a.score).slice(0, 5);
    setMatches(scored);
  };
  return (<div className="grid grid-cols-1 lg:grid-cols-[minmax(340px,1fr)_minmax(0,1.4fr)] gap-4 items-start">
    <div className="bg-panel border border-line rounded-card"><div className="px-4 py-3 border-b border-line font-semibold">Candidate</div><div className="p-4 text-[13px]">
      <select value={cid} onChange={(e) => setCid(e.target.value)} className="w-full border border-line rounded px-2.5 py-2">{candidates.map((x) => <option key={x.id} value={x.id}>{x.reference_code} · {x.trade}{x.availability_from ? ` · from ${x.availability_from}` : ''}</option>)}</select>
      {c && <div className="grid grid-cols-[92px_minmax(0,1fr)] sm:grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 mt-3"><span className="text-ink3">Projects</span><span>{(c.profile?.projects ?? []).map((p: any) => `${p.type}, ${p.country} ${p.years}`).join('; ') || '—'}</span><span className="text-ink3">Languages</span><span>{(c.profile?.languages ?? []).join(', ')}</span></div>}
      <button className="btn btn-primary mt-4" onClick={match} disabled={!c}>Match</button>
    </div></div>
    <div className="bg-panel border border-line rounded-card"><div className="px-4 py-3 border-b border-line flex justify-between"><b className="font-semibold">Who should hear about this person</b><span className="text-ink3 text-[12px]">trade · prior site · client type</span></div>
      {matches.length === 0 ? <div className="p-9 text-center text-ink3">Pick a candidate and press Match.</div> : matches.map((m) => <div key={m.id} className="px-4 py-3 border-b border-line2 last:border-0 grid grid-cols-[1fr_auto] gap-3 text-[13px]"><div><div className="font-medium">{m.companies?.name} · {m.project_location}</div><div className="text-ink2 text-[12px]">{m.project_name}</div><div className="text-ink3 text-[12px]">{m.contacts?.[0] ? `To: ${m.contacts[0].name}, ${m.contacts[0].title} · email ${m.contacts[0].email_status}` : 'No named contact yet'}{!m.confirmed_at && ' · source not confirmed'}</div><a className="text-accent text-[12px]" href={`/app/radar?lead=${m.id}`}>Open lead → draft teaser</a></div><b className="text-accent">{m.score}</b></div>)}
    </div>
  </div>);
}
