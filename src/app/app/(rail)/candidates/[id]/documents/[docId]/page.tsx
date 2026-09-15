import Link from 'next/link';
import { notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { candidateLabel } from '@/lib/candidate-number';
import { CertCard } from '@/components/CertCard';
export const dynamic = 'force-dynamic';

/**
 * A certificate's original beside its decoded reading (item 24): the uploaded PDF or image on one side, and on the other
 * the same three layers the candidate page shows — what the document says, what it means, how far confirming it has got —
 * so a recruiter can hold one against the other. A file type a browser cannot show (DOCX) is offered as a download and
 * says so. SENSITIVE PERSONAL DATA: the row is read under row-level security; the file is served by a 60-second signed link.
 */
export default async function CertificateOriginal({ params }: { params: { id: string; docId: string } }) {
  const sb = supabaseServer();
  const { data: d, error } = await sb.from('documents')
    .select('id, type, cert_body, storage_path, uploaded_at, extracted, candidate_id, candidates!candidate_id(id, reference_code, full_name), verifications(result, state, valid_until, checked_where, checked_at, notes)')
    .eq('id', params.docId).maybeSingle() as { data: any; error: any };
  if (error) return <div className="bg-panel border border-bad rounded-card p-4 text-[13px]"><b className="text-bad">The document could not be read.</b><details className="mt-1 text-[12px] text-ink3"><summary>Technical detail</summary><pre className="whitespace-pre-wrap">{error.message}</pre></details></div>;
  if (!d || d.candidate_id !== params.id) notFound();

  const ext = (String(d.storage_path).match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? '').toLowerCase();
  const src = `/api/candidates/document?id=${d.id}`;
  const v = [...(d.verifications ?? [])].sort((a: any, b: any) => String(b.checked_at ?? '').localeCompare(String(a.checked_at ?? '')))[0];

  return (<>
    <div className="text-[13px] mb-3 flex flex-wrap gap-3 items-center justify-between">
      <Link href={`/app/candidates/${params.id}`} className="text-accent">← {candidateLabel(d.candidates?.reference_code)} · {d.candidates?.full_name ?? 'candidate'}</Link>
      <a className="btn" href={`${src}&download=1`} data-original-download>Download original</a>
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
      <section className="bg-panel border border-line rounded-card overflow-hidden min-w-0" data-original>
        <div className="px-4 py-2.5 border-b border-line text-[12px] text-ink3 uppercase tracking-wide">Original, as uploaded {new Date(d.uploaded_at).toLocaleDateString('en-GB')}</div>
        {ext === 'pdf'
          ? <iframe title="Original certificate" src={src} className="w-full h-[70vh] min-h-[420px] block" data-original-kind="pdf" />
          : ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={src} alt="Original certificate" className="w-full h-auto block" data-original-kind="image" />
            : <div className="p-5 text-[13px]" data-original-kind="download">This file type ({ext || 'unknown'}) cannot be shown in the browser. <a className="text-accent" href={`${src}&download=1`}>Download the original</a> to look at it.</div>}
      </section>
      <section className="bg-panel border border-line rounded-card px-4 sm:px-5 py-4 min-w-0" data-decoded>
        <div className="text-[12px] text-ink3 uppercase tracking-wide mb-2">Decoded reading</div>
        <CertCard res={{ extracted: { ...(d.extracted ?? {}), cert_body: d.cert_body }, verification: v, state: v?.state, documentId: d.id }} />
      </section>
    </div>
  </>);
}
