import { Help } from '@/components/Help';
import { VerifyClient } from '@/components/VerifyClient';
import { currentUser, supabaseServer } from '@/lib/supabase/server';
import { Unattached } from '@/components/Unattached';
export const dynamic = 'force-dynamic';

/** One drop zone. No tabs: the file says what it is, not the recruiter. */
export default async function Verify() {
  const me = await currentUser();
  // Documents that belong to nobody. Read here rather than in the client so the panel is right
  // on first paint and does not flash an empty state over seven waiting certificates.
  const sb = supabaseServer();
  const { data: orphans } = await sb
    .from('documents')
    .select('id, type, cert_body, extracted, uploaded_at')
    .is('candidate_id', null)
    .order('uploaded_at', { ascending: false })
    .limit(50);
  return (<>
    <div className="flex items-baseline justify-between flex-wrap gap-x-3 gap-y-1 mb-4">
      <h1 className="font-display text-[26px] font-bold tracking-[-.4px]">
        Verify
        <Help
          title="What Verify does"
          intro="Verify is the only way documents enter the system. Drop anything a candidate sends; each file is recognised and handled: CVs are anonymized with three client bullets and a downloadable PDF; certificates are checked with the issuer and show what they cover and until when; passports and contracts feed cross-checks and availability. Nothing is sent anywhere; nothing is marked verified without a source."
          rows={[
            ['Recognised', 'CV, certificate, passport, contract, medical, A1, welding test report.'],
            ['Grouped', 'Results are grouped by candidate. Only a CV creates a new candidate; other documents attach by the name on them.'],
            ['Never', 'Saves a file it cannot recognise, or marks something verified without a fetched source.'],
          ]}
        />
      </h1>
      <span className="text-ink3">Nothing leaves the system · recruiter-initiated only</span>
    </div>
    <Unattached docs={(orphans ?? []).map((d: any) => ({
      id: d.id, type: d.type, cert_body: d.cert_body,
      holder: d.extracted?.holder ?? null,
      file: d.extracted?.number ? `no. ${d.extracted.number}` : null,
      uploaded_at: d.uploaded_at,
    }))} />
    <VerifyClient senior={me?.role === 'senior'} />
  </>);
}
