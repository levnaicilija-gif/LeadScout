import { Help } from './Help';

/**
 * Hiring now — trade postings taken from companies' own careers pages.
 *
 * These are not leads. A lead is something a recruiter decides to create; a posting is just a
 * fact about a company that we read this morning, so it hangs off the company and carries its
 * own link back to the page it came from.
 */
export type Posting = {
  id: string;
  title: string | null;
  role: string | null;
  location: string | null;
  country: string | null;
  trades: string[] | null;
  certs_required: string[] | null;
  rotation: string | null;
  contract_type: string | null;
  headcount: number | null;
  posted_at: string | null;
  first_seen_at: string | null;
  source_url: string;
  via: string | null;
  companies: { name: string; employer_type: string | null; country: string | null; domain: string | null } | null;
};

const day = (s?: string | null) => (s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—');

export function HiringNow({ postings, crawledAt, companiesWithBoards }: { postings: Posting[]; crawledAt?: string | null; companiesWithBoards: number }) {
  // One row per posting, newest first, grouped visually by company.
  return (
    <div className="bg-panel border border-line rounded overflow-auto max-h-[calc(100vh-190px)]">
      <table className="tbl w-full min-w-[1100px] border-collapse">
        <thead>
          <tr>
            <th>Company</th><th>Role</th><th>Where</th><th>Trades</th>
            <th>Certificates asked for</th><th>Posted</th><th>Source</th>
          </tr>
        </thead>
        <tbody>
          {postings.map((p) => (
            <tr key={p.id} className="hover:bg-[#F9FAFB]">
              <td>
                <div className="font-medium whitespace-nowrap">{p.companies?.name ?? '—'}</div>
                <div className="text-ink3 text-[12px]">
                  {[p.companies?.country, p.companies?.employer_type?.replace(/_/g, ' ')].filter(Boolean).join(' · ')}
                </div>
              </td>
              <td>
                <div>{p.role ?? p.title}</div>
                <div className="text-ink3 text-[12px]">
                  {[p.headcount ? `×${p.headcount}` : null, p.contract_type, p.rotation].filter(Boolean).join(' · ') || '—'}
                </div>
              </td>
              <td className="text-[13px]">{p.location ?? p.country ?? '—'}</td>
              <td>
                {(p.trades ?? []).map((t) => (
                  <span key={t} className="inline-block text-[12px] px-1.5 py-0.5 rounded bg-line2 text-ink2 mr-1 mb-1">{t}</span>
                ))}
                {!(p.trades ?? []).length && <span className="text-ink3 text-[12px]">—</span>}
              </td>
              <td className="text-[13px]">
                {(p.certs_required ?? []).join(', ') || <span className="text-ink3">none stated</span>}
              </td>
              <td className="text-[13px] whitespace-nowrap">
                {day(p.posted_at)}
                {!p.posted_at && p.first_seen_at && <div className="text-ink3 text-[12px]">first seen {day(p.first_seen_at)}</div>}
              </td>
              <td className="text-[13px]">
                <a href={p.source_url} target="_blank" rel="noopener" className="text-accent">Open posting</a>
                <div className="text-ink3 text-[12px]">read via {p.via ?? '—'}</div>
              </td>
            </tr>
          ))}

          {postings.length === 0 && (
            <tr><td colSpan={7} className="text-ink3 p-6">
              {companiesWithBoards === 0
                ? 'No careers pages found yet. Discovery has not run over the company list.'
                : `No trade postings open. ${companiesWithBoards} careers page${companiesWithBoards === 1 ? '' : 's'} are being read${crawledAt ? `, last on ${new Date(crawledAt).toLocaleString('en-GB')}` : ''}; nothing on them is for a trade we place.`}
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export const HiringHelp = () => (
  <Help
    title="What Hiring now is"
    intro="Trade postings taken from companies' own careers pages — not job boards, and not adverts placed by other agencies."
    rows={[
      ['Comes from', 'The company\'s own board. Where they use an ATS we read its published list; otherwise the careers page itself.'],
      ['Filtered by', 'Every title is read and only trades we place are kept — welders, fitters, blasters, NDT, scaffolders, riggers, electricians, wind techs and the supervisors over them.'],
      ['Closed', 'A posting that disappears from the board is marked closed rather than deleted, so you can see what has just been filled.'],
      ['Never', 'Invents a posting, a certificate requirement or a headcount. Everything links back to the page it was read from.'],
    ]}
  />
);
