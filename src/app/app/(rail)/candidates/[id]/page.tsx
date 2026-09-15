import Link from 'next/link';
import { notFound } from 'next/navigation';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { hasCandidateCrm } from '@/lib/schema-features';
import { candidateLabel } from '@/lib/candidate-number';
import { STAGES, type Stage, type Preference } from '@/lib/candidate-stages';
import { CertCard } from '@/components/CertCard';
import { CandidateTableStage } from '@/components/CandidateTableStage';
import { CandidateEditForm } from '@/components/CandidateEditForm';
import { CvSentLog } from '@/components/CvSentLog';
import { AnonymizeAction } from '@/components/AnonymizeAction';
import { CandidateDocDrop } from '@/components/CandidateDocDrop';
export const dynamic = 'force-dynamic';

/**
 * One candidate, one page (item 24 — Loxo's "one page, not five tabs"): who they are and the fields a recruiter edits, the
 * CV, the certificates, the CVs sent and the placements, all visible together. SENSITIVE PERSONAL DATA: read with the
 * signed-in user's client, so row-level security decides; the parsed profile stays on this internal page.
 *
 * Certificates render with CertCard — the same three layers Verify shows: what the document says, what it means (decoded
 * from the certificate tables, CertExplanation) and how far confirming it has got.
 */
export default async function CandidatePage({ params }: { params: { id: string } }) {
  const me = await currentUser();
  const sb = supabaseServer();
  const crm = await hasCandidateCrm(sb);

  const cols = [
    'id, reference_code, full_name, phone, email, trade, languages, availability_from, internal_notes, nationality, created_via, created_by, created_at, profile',
    crm ? 'stage, employment_preference, country, owner_id, data_retention_until, stage_changed_at' : '',
    'documents!candidate_id(id, type, cert_body, status, uploaded_at, extracted, verifications(result, state, valid_until, checked_where, checked_at, notes))',
    `sends(id, sent_at, sent_by, ${crm ? 'client_name, note, ' : ''}companies(name))`,
    crm ? 'candidate_placements(client_name, placed_on, ended_on, placed_by, placed_at)' : '',
    'anonymized_cvs(id, generated_at, pii_check_passed, storage_path)',
  ].filter(Boolean).join(', ');
  const { data: c, error } = await sb.from('candidates').select(cols as '*').eq('id', params.id).maybeSingle() as { data: any; error: any };
  if (error) {
    return <div className="bg-panel border border-bad rounded-card p-4 text-[13px]"><b className="text-bad">This candidate could not be read, so the page is not showing their record.</b><details className="mt-1 text-[12px] text-ink3"><summary className="cursor-pointer">Technical detail</summary><pre className="whitespace-pre-wrap mt-1">{error.message}</pre></details></div>;
  }
  if (!c) notFound();

  // Who logged what: names of the people behind sent_by, placed_by, owner and creator.
  const people = [...new Set([c.owner_id, c.created_by, ...(c.sends ?? []).map((s: any) => s.sent_by), ...(c.candidate_placements ?? []).map((p: any) => p.placed_by)].filter(Boolean))];
  const { data: users } = people.length ? await sb.from('users').select('id, name').in('id', people) : { data: [] as any[] };
  const nameOf = (id?: string | null) => (users ?? []).find((u: any) => u.id === id)?.name ?? (id ? 'a former user' : '—');

  const docs: any[] = c.documents ?? [];
  const certificates = docs.filter((d) => d.type === 'certificate');
  const cvs = docs.filter((d) => d.type === 'cv').sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)));
  const otherDocs = docs.filter((d) => d.type !== 'certificate' && d.type !== 'cv');
  const latestAnon: any = [...(c.anonymized_cvs ?? [])].sort((a: any, b: any) => String(b.generated_at).localeCompare(String(a.generated_at)))[0];
  const profile: any = c.profile ?? {};
  const placements = [...(c.candidate_placements ?? [])].sort((a: any, b: any) => String(b.placed_on).localeCompare(String(a.placed_on)));
  const current = placements.find((p: any) => !p.ended_on);
  const sends = [...(c.sends ?? [])].sort((a: any, b: any) => String(b.sent_at).localeCompare(String(a.sent_at))).map((s: any) => ({
    id: s.id, client: s.client_name ?? s.companies?.name ?? 'client not recorded', sentAt: s.sent_at, by: nameOf(s.sent_by), note: s.note ?? null,
  }));
  const stage: Stage = (STAGES as readonly string[]).includes(c.stage) ? c.stage : 'new';
  const Card = ({ title, hook, children, aside }: { title: string; hook: string; children: React.ReactNode; aside?: React.ReactNode }) => (
    <section data-candidate-section={hook} className="bg-panel border border-line rounded-card px-4 sm:px-5 py-4">
      <div className="flex items-baseline justify-between gap-2 mb-2"><h2 className="text-[15px] font-semibold m-0">{title}</h2>{aside}</div>
      {children}
    </section>
  );

  return (<>
    <div className="text-[13px] mb-2"><Link href="/app/candidates" className="text-accent">← Candidates</Link></div>
    <header className="flex flex-wrap items-end justify-between gap-3 mb-4" data-candidate-header>
      <div className="min-w-0">
        <h1 className="font-display text-[26px] font-bold tracking-[-.4px] m-0 break-words">
          <span data-candidate-number>{candidateLabel(c.reference_code)}</span> · {c.full_name ?? 'name not printed'}
        </h1>
        <div className="text-ink3 text-[12.5px] mt-0.5">{c.reference_code} · {c.trade ?? 'trade not stated'} · added {new Date(c.created_at).toLocaleDateString('en-GB')} via {c.created_via}{crm ? ` · owner ${nameOf(c.owner_id ?? c.created_by)}` : ''}</div>
      </div>
      <div className="flex items-center gap-2 text-[13px]">
        <span className="text-ink3">Stage</span>
        {crm ? <CandidateTableStage candidate={{ id: c.id, name: c.full_name, stage, placedAt: current?.client_name ?? null }} /> : <span className="text-ink3">arrives with 0035</span>}
      </div>
    </header>

    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 items-start">
      <div className="grid gap-4 min-w-0">
        <Card title="Details" hook="details">
          <CandidateEditForm crm={crm} candidate={{
            id: c.id, full_name: c.full_name ?? '', phone: c.phone ?? '', email: c.email ?? '', trade: c.trade ?? '', country: c.country ?? '',
            availability_from: c.availability_from ?? '', notes: c.internal_notes ?? '', employment_preference: (c.employment_preference ?? '') as Preference | '',
            data_retention_until: c.data_retention_until ?? '',
          }} />
        </Card>

        <Card title="CVs sent to clients" hook="cv-sent">
          <CvSentLog candidateId={c.id} enabled={crm} initial={sends} />
        </Card>

        <Card title="Placements" hook="placements">
          {!crm ? <div className="text-ink3 text-[13px]">Placements arrive with migration 0035.</div>
            : placements.length === 0 ? <div className="text-ink3 text-[13px]">Not placed yet. Set the stage to Placed to record the client and the date.</div>
              : <ul className="list-none m-0 p-0 grid gap-2 text-[13px]">
                {placements.map((p: any, i: number) => (
                  <li key={i} data-placement className="border border-line2 rounded px-3 py-2">
                    <b className="font-semibold">{p.client_name}</b> · from {p.placed_on}{p.ended_on ? ` to ${p.ended_on}` : <span className="text-ok"> · current</span>}
                    <div className="text-ink3 text-[12px]">entered by {nameOf(p.placed_by)} on {new Date(p.placed_at).toLocaleString('en-GB')}</div>
                  </li>
                ))}
              </ul>}
        </Card>
      </div>

      <div className="grid gap-4 min-w-0">
        <Card title="CV" hook="cv">
          {cvs.length === 0 ? <div className="text-ink3 text-[13px]">No CV on file. Drop one anywhere in the app.</div> : (
            <div className="text-[13px] grid gap-1">
              <div><span className="text-ink3">Trade</span> · {profile.trade ?? c.trade ?? '—'}{(profile.trades ?? []).length ? ` (${profile.trades.join(', ')})` : ''}</div>
              <div><span className="text-ink3">Languages</span> · {(profile.languages ?? c.languages ?? []).join(', ') || '—'}</div>
              <div><span className="text-ink3">Work history</span> · {(profile.projects ?? []).length} period{(profile.projects ?? []).length === 1 ? '' : 's'} on the CV</div>
              <div><span className="text-ink3">Certificates the CV claims</span> · {(profile.certificates_claimed ?? []).join(', ') || '—'}</div>
              <div className="text-ink3 text-[12px]">{cvs.length} CV file{cvs.length === 1 ? '' : 's'} on file · latest {new Date(cvs[0].uploaded_at).toLocaleDateString('en-GB')}</div>
              <div className="flex flex-wrap gap-2 mt-1.5">
                <Link href={`/app/candidates/${c.id}/cv`} className="btn btn-primary" data-read-cv>Read CV</Link>
                <a href={`/api/candidates/document?id=${cvs[0].id}&download=1`} className="btn" data-download-cv>Download original</a>
              </div>
            </div>
          )}
        </Card>

        <Card title="Client version" hook="client-version">
          <AnonymizeAction candidateId={c.id} hasCv={cvs.length > 0} senior={me?.role === 'senior'} latest={latestAnon ? { generatedAt: latestAnon.generated_at, piiPassed: !!latestAnon.pii_check_passed, hasPdf: !!latestAnon.storage_path } : null} />
        </Card>

        <Card title={`Certificates · ${certificates.length}`} hook="certificates">
          <CandidateDocDrop candidateId={c.id} label={candidateLabel(c.reference_code)} />
          {certificates.length === 0 ? <div className="text-ink3 text-[13px]">No certificates on file.</div> : (
            <div className="grid gap-4">
              {certificates.map((d: any) => {
                const v = [...(d.verifications ?? [])].sort((a: any, b: any) => String(b.checked_at ?? '').localeCompare(String(a.checked_at ?? '')))[0];
                return <div key={d.id} data-candidate-certificate={d.id} className="border-t border-line2 pt-3 first:border-t-0 first:pt-0"><CertCard res={{ extracted: { ...(d.extracted ?? {}), cert_body: d.cert_body }, verification: v, state: v?.state, documentId: d.id }} /><Link href={`/app/candidates/${c.id}/documents/${d.id}`} className="text-accent text-[13px] mt-2 inline-block" data-view-original={d.id}>View original</Link></div>;
              })}
            </div>
          )}
        </Card>

        {otherDocs.length > 0 && (
          <Card title="Other documents" hook="documents">
            <ul className="list-none m-0 p-0 text-[13px] grid gap-1">{otherDocs.map((d: any) => <li key={d.id}>{d.type} · {new Date(d.uploaded_at).toLocaleDateString('en-GB')} · {d.status}</li>)}</ul>
          </Card>
        )}
      </div>
    </div>
  </>);
}
