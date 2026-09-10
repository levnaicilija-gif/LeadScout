import { Help } from '@/components/Help';
import { VerifyClient } from '@/components/VerifyClient';
import { currentUser } from '@/lib/supabase/server';
export const dynamic = 'force-dynamic';

/** One drop zone. No tabs: the file says what it is, not the recruiter. */
export default async function Verify() {
  const me = await currentUser();
  return (<>
    <div className="flex items-baseline justify-between mb-4">
      <h1 className="text-[22px] font-semibold">
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
    <VerifyClient senior={me?.role === 'senior'} />
  </>);
}
