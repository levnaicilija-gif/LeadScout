import { Help } from '@/components/Help';
import { VerifyClient } from '@/components/VerifyClient';
export default function Verify({ searchParams }: { searchParams: { tab?: string } }) {
  const tab = searchParams.tab === 'cv' ? 'cv' : 'cert';
  return (<>
    <div className="flex items-baseline justify-between mb-3"><h1 className="text-[22px] font-semibold">Verify<Help title="What Verify is" intro="The only way documents enter the system — when you drop them." rows={[['Certificates', 'Checked on the issuer\'s official site. You get valid/not, valid until, where, when, screenshot. Welder certs: test-report consistency now, issuer confirmation by email.'], ['CVs', 'Any language → anonymized client version, three bullets, optional job match; several CVs + one job → ranked.'], ['Never', 'Marks something verified without a fetched source. Puts a name on a client document.']]} /></h1><span className="text-ink3">Nothing leaves the system · recruiter-initiated only</span></div>
    <div className="flex gap-0.5 border-b border-line mb-3">{[['cert', 'Certificate check'], ['cv', 'CV anonymizer']].map(([t, l]) => <a key={t} href={`?tab=${t}`} className={`px-3.5 py-2 -mb-px border-b-2 ${tab === t ? 'border-ink text-ink font-medium' : 'border-transparent text-ink3'}`}>{l}</a>)}</div>
    <VerifyClient mode={tab} />
  </>);
}
