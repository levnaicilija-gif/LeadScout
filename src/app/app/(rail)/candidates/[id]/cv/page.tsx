import Link from 'next/link';
import { notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { candidateLabel } from '@/lib/candidate-number';
import { STATE_LABEL, type CertState } from '@/lib/verify/routes';
export const dynamic = 'force-dynamic';

/**
 * A candidate's CV in one standard reading layout (item 24): name, trade, contact, certificates, work history, languages,
 * skills and availability, in the same order for everyone however the original was formatted. Built from the reading
 * already stored with the CV (parseCv, the same logic Verify uses) — nothing is read again and nothing is inferred; a
 * section the CV did not state says so. The original file stays downloadable beside it. SENSITIVE PERSONAL DATA: internal
 * page, read with the signed-in user's client.
 */
export default async function CandidateCv({ params }: { params: { id: string } }) {
  const sb = supabaseServer();
  const { data: c, error } = await sb.from('candidates')
    .select('id, reference_code, full_name, phone, email, trade, availability_from, profile, documents!candidate_id(id, type, uploaded_at, cert_body, extracted, verifications(state, valid_until, checked_at))')
    .eq('id', params.id).maybeSingle() as { data: any; error: any };
  if (error) return <div className="bg-panel border border-bad rounded-card p-4 text-[13px]"><b className="text-bad">The CV could not be read.</b><details className="mt-1 text-[12px] text-ink3"><summary>Technical detail</summary><pre className="whitespace-pre-wrap">{error.message}</pre></details></div>;
  if (!c) notFound();

  const docs: any[] = c.documents ?? [];
  const cvs = docs.filter((d) => d.type === 'cv').sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)));
  const latest = cvs[0];
  // The reading stored with the latest CV file, else the candidate's profile (a CV attached before item 24).
  const p: any = latest?.extracted?.profile ?? c.profile ?? {};
  const certs = docs.filter((d) => d.type === 'certificate').map((d) => {
    const v = [...(d.verifications ?? [])].sort((a: any, b: any) => String(b.checked_at ?? '').localeCompare(String(a.checked_at ?? '')))[0];
    return { id: d.id, name: [d.cert_body?.toUpperCase(), d.extracted?.level && `Level ${d.extracted.level}`].filter(Boolean).join(' ') || 'Certificate', number: d.extracted?.number ?? null, validUntil: v?.valid_until ?? d.extracted?.expiry ?? null, state: v?.state as CertState | undefined };
  });
  const none = (what: string) => <span className="text-ink3">not stated on the CV{what ? ` — ${what}` : ''}</span>;
  const Section = ({ title, hook, children }: { title: string; hook: string; children: React.ReactNode }) => (
    <section data-cv-section={hook} className="py-4 border-t border-line first:border-t-0">
      <h2 className="text-[12px] uppercase tracking-wide text-ink3 font-semibold m-0 mb-2">{title}</h2>
      {children}
    </section>
  );

  return (<>
    <div className="text-[13px] mb-2 flex flex-wrap gap-3 items-center justify-between">
      <Link href={`/app/candidates/${c.id}`} className="text-accent">← {candidateLabel(c.reference_code)} · {c.full_name ?? 'candidate'}</Link>
      {latest && <a className="btn" href={`/api/candidates/document?id=${latest.id}&download=1`} data-cv-download>Download original</a>}
    </div>
    <article className="bg-panel border border-line rounded-card px-5 sm:px-8 py-5 max-w-[860px]" data-cv-view>
      <header className="pb-3">
        <h1 className="font-display text-[26px] font-bold m-0 break-words">{p.full_name ?? c.full_name ?? 'Name not printed'}</h1>
        <div className="text-ink2 text-[14px] mt-0.5">{p.trade ?? c.trade ?? 'Trade not stated'}{(p.trades ?? []).length ? ` · ${p.trades.join(', ')}` : ''}</div>
        <div className="text-ink3 text-[12px] mt-1">{candidateLabel(c.reference_code)} · {c.reference_code} · {latest ? `read from the CV uploaded ${new Date(latest.uploaded_at).toLocaleDateString('en-GB')}` : 'no CV file on file — shown from the stored profile'}</div>
      </header>

      <Section title="Contact" hook="contact">
        <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-y-1 text-[13.5px]">
          <span className="text-ink3">Phone</span><span className="break-words">{c.phone ?? p.pii?.phone ?? none('')}</span>
          <span className="text-ink3">Email</span><span className="break-all">{c.email ?? p.pii?.email ?? none('')}</span>
          <span className="text-ink3">Nationality</span><span>{p.nationality ?? none('')}</span>
          <span className="text-ink3">Available</span><span>{c.availability_from ?? p.availability ?? none('')}</span>
        </div>
      </Section>

      <Section title="Certifications" hook="certifications">
        {certs.length === 0 && !(p.certificates_claimed ?? []).length ? none('and none on file') : (
          <div className="grid gap-2 text-[13.5px]">
            {certs.map((x) => <div key={x.id}><b className="font-semibold">{x.name}</b>{x.number ? ` · No. ${x.number}` : ''}{x.validUntil ? ` · valid to ${x.validUntil}` : ''} · <span className="text-ink2">{x.state ? STATE_LABEL[x.state] : 'on file, not checked'}</span></div>)}
            {(p.certificates_claimed ?? []).map((t: string, i: number) => <div key={`c${i}`} className="text-ink2">{t} <span className="text-ink3">· per CV, not a document on file</span></div>)}
          </div>
        )}
      </Section>

      <Section title="Work history" hook="work-history">
        {(p.projects ?? []).length === 0 ? none('') : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13.5px] min-w-[520px]">
              <thead><tr className="text-left text-ink3 text-[12px]"><th className="py-1 pr-3 font-medium">Years</th><th className="py-1 pr-3 font-medium">Work</th><th className="py-1 pr-3 font-medium">Country</th><th className="py-1 pr-3 font-medium">Employer</th><th className="py-1 font-medium">Rotation</th></tr></thead>
              <tbody>{p.projects.map((x: any, i: number) => (
                <tr key={i} className="border-t border-line2 align-top"><td className="py-1.5 pr-3 whitespace-nowrap">{x.years ?? '—'}</td><td className="py-1.5 pr-3">{x.type ?? '—'}{x.scope ? <div className="text-ink3 text-[12px]">{x.scope}</div> : null}</td><td className="py-1.5 pr-3">{x.country ?? '—'}</td><td className="py-1.5 pr-3">{x.employer ?? '—'}</td><td className="py-1.5">{x.rotation ?? '—'}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Languages and skills" hook="skills">
        <div className="text-[13.5px] grid gap-1">
          <div><span className="text-ink3">Languages</span> · {(p.languages ?? []).join(', ') || none('')}</div>
          <div><span className="text-ink3">Skills</span> · {(p.skills ?? []).join(', ') || none('')}</div>
        </div>
      </Section>

      {cvs.length > 1 && (
        <Section title="CV files on file" hook="files">
          <ul className="list-none m-0 p-0 grid gap-1 text-[13px]">{cvs.map((d) => <li key={d.id}>{new Date(d.uploaded_at).toLocaleDateString('en-GB')} · <a className="text-accent" href={`/api/candidates/document?id=${d.id}&download=1`}>download</a></li>)}</ul>
        </Section>
      )}
    </article>
  </>);
}
