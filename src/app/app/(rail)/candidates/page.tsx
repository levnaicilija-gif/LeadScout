import { supabaseServer } from '@/lib/supabase/server';
import { Help } from '@/components/Help';
import { PreviewPdf } from '@/components/PreviewPdf';
import { DownloadPdf } from '@/components/CvCard';
import { currentUser } from '@/lib/supabase/server';
export const dynamic = 'force-dynamic';
export default async function Candidates({ searchParams }: { searchParams: { q?: string; ref?: string } }) {
  const me = await currentUser();
  const sb = supabaseServer(); let q = sb.from('candidates').select('*, documents(type, status, cert_body, verifications(result, valid_until, checked_where, checked_at)), sends(sent_at, revealed_at, companies(name)), anonymized_cvs(storage_path, pii_check_passed)').order('created_at', { ascending: false }).limit(100);
  if (searchParams.q) q = q.or(`full_name.ilike.%${searchParams.q}%,reference_code.ilike.%${searchParams.q}%,phone.ilike.%${searchParams.q}%,trade.ilike.%${searchParams.q}%`);
  if (searchParams.ref) q = q.eq('reference_code', searchParams.ref);
  const { data } = await q;
  return (<>
    <div className="flex items-baseline justify-between mb-3"><h1 className="text-[22px] font-semibold">Candidates<Help title="What Candidates is" intro="The pool. Full name, phone and documents stay here, internal only." rows={[['Where they come from', 'Only from you: Verify → Save, the Add button, or imported records. Radar never creates candidates.'], ['Reveal', 'Releasing a full profile to a client is an explicit, logged action.']]} /></h1><span className="text-ink3">{data?.length ?? 0} shown</span></div>
    <form className="flex gap-2 mb-3"><input name="q" defaultValue={searchParams.q} placeholder="Search name, reference, phone, trade…" className="flex-1 border border-line rounded px-3 py-2 bg-panel" /><button className="btn btn-primary">Search</button></form>
    <div className="bg-panel border border-line rounded overflow-auto"><table className="tbl w-full min-w-[980px] border-collapse"><thead><tr><th>Reference</th><th>Trade</th><th>Certificates</th><th>Docs</th><th>Availability</th><th>Sent to</th><th>Languages</th><th>Origin</th><th>Client CV</th></tr></thead><tbody>
      {(data ?? []).map((c: any) => { const certs = (c.documents ?? []).filter((d: any) => d.type === 'certificate'); return <tr key={c.id}>
        <td><div className="font-medium whitespace-nowrap">{c.reference_code}</div><div className="text-ink3 text-[12px]">{c.full_name}</div></td><td>{c.trade}</td>
        <td>{certs.length ? certs.map((d: any, i: number) => { const v = d.verifications?.[0]; const s = v?.result === 'valid' ? 'st-ok' : v?.result === 'pending' || v?.result === 'consistent_with_test_report' ? 'st-warn' : v ? 'st-bad' : ''; return <span key={i} className={`st mr-2 text-[13px] ${s}`}>{d.cert_body}{v?.valid_until ? ` · ${v.valid_until}` : ''}</span>; }) : <span className="text-ink3">none on file</span>}</td>
        <td>{(c.documents ?? []).length}</td><td>{c.availability_from ?? '—'}</td><td>{(c.sends ?? []).map((s: any) => s.companies?.name).join(', ') || '—'}</td><td>{(c.languages ?? []).join(', ')}</td><td className="text-ink3 text-[12px]">{c.created_via} · {new Date(c.created_at).toLocaleDateString()}</td><td><div className="flex gap-1.5 flex-wrap">{(c.anonymized_cvs ?? []).length ? <><PreviewPdf candidateId={c.id} disabled={!c.anonymized_cvs.some((a: any) => a.pii_check_passed && a.storage_path)} label="Preview" /><DownloadPdf candidateId={c.id} kind="client" label="Client PDF" disabled={!c.anonymized_cvs.some((a: any) => a.pii_check_passed && a.storage_path)} /></> : <span className="text-ink3">—</span>}<DownloadPdf candidateId={c.id} kind="internal" label="Internal" senior={me?.role === 'senior'} /></div></td></tr>; })}
      {(data ?? []).length === 0 && <tr><td colSpan={9} className="p-6 text-ink3">No candidates yet. Drop a CV into Verify → CV anonymizer.</td></tr>}
    </tbody></table></div>
  </>);
}
