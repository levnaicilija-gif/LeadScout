import { supabaseAdmin } from '@/lib/supabase/server';

/**
 * Rendered per request, never cached.
 *
 * Without this the route cache held the first render of a slug: /v/rfbt-f-0009 kept serving
 * "Not found" long after the client version had been produced. A page a client opens to check
 * a certificate is the last place that may show yesterday's answer.
 */
export const dynamic = 'force-dynamic';

/** Public verification summary: certificate statuses and where they were checked. NO personal data. */
export default async function V({ params }: { params: { slug: string } }) {
  const db = supabaseAdmin();
  const { data: cv } = await db.from('anonymized_cvs').select('bullets, generated_at, candidates(reference_code, trade, documents(type, cert_body, verifications(result, valid_until, checked_where, checked_at)))').eq('public_slug', params.slug).order('version', { ascending: false }).limit(1).maybeSingle();
  if (!cv) {
    // A reference that exists but has no client version yet is not the same as a wrong link,
    // and a bare "Not found." sends the recruiter looking for a broken URL instead of the
    // step that has not run. Say which it is.
    const { data: cand } = await db.from('candidates')
      .select('reference_code, trade').ilike('reference_code', params.slug).maybeSingle();
    return (
      <main className="max-w-[640px] mx-auto p-10 text-[13px]">
        <div className="flex justify-between border-b-2 border-ink pb-3 mb-4">
          <div>
            <h1 className="text-[18px] font-semibold">{cand ? 'Client version not prepared yet' : 'Nothing at this address'}</h1>
            <div className="text-ink3 text-[12px]">
              {cand ? <>Reference {cand.reference_code}{cand.trade ? ` · ${cand.trade}` : ''}</> : <>Reference {params.slug.toUpperCase()} is not one of ours.</>}
            </div>
          </div>
          <span className="w-8 h-8 rounded-md bg-rail text-white grid place-items-center font-bold">R</span>
        </div>
        <p className="text-ink2">
          {cand
            ? 'This candidate is on file, but the anonymized client version has not been produced yet. It appears here as soon as it is.'
            : 'Check the link. Nothing is published for this reference.'}
        </p>
        <div className="mt-6 pt-3 border-t border-line text-[11px] text-ink3 flex justify-between">
          <span>RFBT Recruitment · London · Beograd</span><span>Full profile released on client confirmation</span>
        </div>
      </main>
    );
  }
  const c: any = cv.candidates; const certs = (c.documents ?? []).filter((d: any) => d.type === 'certificate');
  return (<main className="max-w-[640px] mx-auto p-10 text-[13px]"><div className="flex justify-between border-b-2 border-ink pb-3 mb-4"><div><h1 className="text-[18px] font-semibold">{c.trade}</h1><div className="text-ink3 text-[12px]">Reference {c.reference_code} · verification summary · {new Date(cv.generated_at).toLocaleDateString()}</div></div><span className="w-8 h-8 rounded-md bg-rail text-white grid place-items-center font-bold">R</span></div>
    <b>Certificates — checked by RFBT</b><table className="w-full mt-2 mb-4"><thead><tr className="text-ink3 text-[12px]"><th className="text-left py-1">Certificate</th><th className="text-left">Checked where</th><th className="text-left">Checked</th><th className="text-left">Valid until</th><th className="text-left">Status</th></tr></thead><tbody>{certs.map((d: any, i: number) => { const v = d.verifications?.[0]; return <tr key={i} className="border-t border-line"><td className="py-1.5">{d.cert_body}</td><td>{v?.checked_where ? new URL(v.checked_where).hostname : v?.result === 'consistent_with_test_report' ? 'Test report on file' : '—'}</td><td>{v?.checked_at ? new Date(v.checked_at).toLocaleDateString() : '—'}</td><td>{v?.valid_until ?? '—'}</td><td className={v?.result === 'valid' ? 'text-ok' : v?.result === 'pending' ? 'text-warn' : ''}>{v?.result?.replace(/_/g, ' ') ?? 'not checked'}</td></tr>; })}</tbody></table>
    <b>Summary</b><ul className="list-disc pl-5 mt-1">{(cv.bullets ?? []).map((b: string, i: number) => <li key={i}>{b}</li>)}</ul>
    <div className="mt-6 pt-3 border-t border-line text-[11px] text-ink3 flex justify-between"><span>RFBT Recruitment · London · Beograd</span><span>Full profile released on client confirmation</span></div></main>);
}
