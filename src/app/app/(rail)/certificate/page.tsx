import { Help } from '@/components/Help';
import { CertificateClient } from '@/components/CertificateClient';
export const dynamic = 'force-dynamic';

/**
 * Certificate check — one drop zone, certificates only.
 *
 * Verify is the way documents enter the system and it takes everything: CVs, passports, contracts, medicals,
 * A1s, test reports. That is right for a candidate's paperwork and wrong for the question a recruiter asks
 * holding one ticket — is this real, what does it cover, until when — where there is no candidate yet and the
 * CV anonymiser, the job-matching panel and the list of documents belonging to nobody are all in the way.
 *
 * So: a second front door onto the SAME code. The decode (src/lib/certs), the issuer lookup
 * (/api/verify/lookup) and the three-layer card (CertCard) are Verify's, reached rather than reimplemented,
 * and Verify itself is untouched. This page reads nothing about candidates and writes nothing to them: the
 * certificate is stored unattached, which is what lets it be attached to somebody later — deliberately, on
 * Verify, rather than by a name match nobody asked for.
 */
export default async function Certificate() {
  return (<>
    <div className="mb-4 flex items-baseline justify-between flex-wrap gap-x-3 gap-y-1">
      <h1 className="font-display text-[26px] font-bold tracking-[-.4px]">
        Certificate check
        <Help
          title="What this screen does"
          intro="One question, answered: what does this certificate say, and does the issuing body confirm it? The number is decoded against the standard it names, then checked on the issuer's own register where one exists. Nothing is invented — a body with no public register says so and stays 'confirm manually'."
          rows={[
            ['Takes', 'Certificates only — FROSIO, PCN, CSWIP, AMPP, IRATA, GWO, CISRS, welder ISO 9606, electrical. PDF or photo.'],
            ['Refuses', 'Anything else. A CV, passport or contract is not stored here — drop those into Verify, which takes every kind.'],
            ['Nobody is touched', 'No candidate is created and none is changed. The certificate is filed on its own.'],
            ['Afterwards', 'It waits in Verify under "documents attached to nobody", where you can put it on a candidate when you know whose it is.'],
            ['Never', 'Marks a certificate verified without a fetched source, or emails anyone.'],
          ]}
        />
      </h1>
      <span className="text-ink3">Nothing leaves the system · recruiter-initiated only</span>
    </div>
    <CertificateClient />
  </>);
}
