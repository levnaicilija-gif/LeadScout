import { Help } from './Help';

/**
 * Hiring now — one row per company, not per posting.
 *
 * These are not leads. A lead is something a recruiter decides to create; a posting is a fact
 * about a company that we read this morning. Grouping matters as much as the facts: Mennens
 * alone had twenty-six Servicemonteur adverts across twenty Dutch towns and filled half the
 * screen, hiding Aibel and Equinor underneath. What a recruiter needs to see is that Mennens is
 * hiring twenty-six fitters, on one line.
 */
export type Posting = {
  id: string;
  company_id: string;
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
  /** Board postings only: who placed the advert, which is often not who is hiring. */
  poster_name?: string | null;
  poster_type?: string | null;
  is_secondary?: boolean | null;
  duplicate_of?: string | null;
  companies: { name: string; employer_type: string | null; country: string | null } | null;
};

type Group = {
  company: string;
  employerType: string | null;
  country: string | null;
  postings: Posting[];
  roles: { name: string; n: number }[];
  trades: string[];
  certs: string[];
  places: string[];
  /** Where the evidence came from: the company itself, or somebody advertising on a board. */
  fromOwnBoard: boolean;
  boardPosters: string[];
  newest: string | null;
  pressure: 'high' | 'medium' | 'low';
};

const day = (s?: string | null) => (s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null);

/** Two "Servicemonteur" adverts in two towns are one role hiring twice. */
const roleKey = (p: Posting) => (p.role ?? p.title ?? '').replace(/\s*[-–—|,(].*$/, '').replace(/\s+/g, ' ').trim();

export function groupByCompany(postings: Posting[]): Group[] {
  const byCompany = new Map<string, Posting[]>();
  for (const p of postings) {
    const k = p.company_id ?? p.companies?.name ?? 'unknown';
    (byCompany.get(k) ?? byCompany.set(k, []).get(k)!).push(p);
  }

  const groups: Group[] = [...byCompany.values()].map((ps) => {
    const counts = new Map<string, number>();
    for (const p of ps) { const k = roleKey(p) || 'Trade role'; counts.set(k, (counts.get(k) ?? 0) + 1); }
    const roles = [...counts.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));

    // Headcount where a posting states one, otherwise one person per advert.
    const openings = ps.reduce((sum, p) => sum + (p.headcount && p.headcount > 0 ? p.headcount : 1), 0);
    const dates = ps.map((p) => p.posted_at ?? p.first_seen_at).filter(Boolean).sort() as string[];
    const newest = dates.length ? dates[dates.length - 1] : null;
    const fresh = newest ? (Date.now() - Date.parse(newest)) / 86400000 <= 30 : false;

    return {
      company: ps[0].companies?.name ?? 'Unknown company',
      employerType: ps[0].companies?.employer_type ?? null,
      country: ps[0].country ?? ps[0].companies?.country ?? null,
      postings: ps,
      roles,
      trades: [...new Set(ps.flatMap((p) => p.trades ?? []))],
      certs: [...new Set(ps.flatMap((p) => p.certs_required ?? []))],
      places: [...new Set(ps.map((p) => p.location).filter(Boolean) as string[])],
      fromOwnBoard: ps.some((p) => p.via !== 'board'),
      boardPosters: [...new Set(ps.filter((p) => p.via === 'board' && p.poster_name).map((p) => p.poster_name as string))],
      newest,
      // Pressure is volume and recency together: five open trade roles is a campaign, and one
      // advert from March is not.
      pressure: openings >= 5 && fresh ? 'high' : openings >= 5 || (openings >= 2 && fresh) ? 'medium' : 'low',
    };
  });

  const rank = { high: 0, medium: 1, low: 2 };
  return groups.sort((a, b) =>
    rank[a.pressure] - rank[b.pressure]
    || b.postings.length - a.postings.length
    || (b.newest ?? '').localeCompare(a.newest ?? ''));
}

const Pressure = ({ p }: { p: Group['pressure'] }) => (
  <span className={`st ${p === 'high' ? 'st-bad' : p === 'medium' ? 'st-warn' : ''}`}>{p}</span>
);

export function HiringNow({
  postings, crawledAt, companiesWithBoards, showAgencies, hiddenAgencies, duplicates = 0,
}: {
  postings: Posting[];
  crawledAt?: string | null;
  companiesWithBoards: number;
  showAgencies: boolean;
  hiddenAgencies: number;
  /** Board adverts that repeat a company's own careers page, dropped from the view. */
  duplicates?: number;
}) {
  const groups = groupByCompany(postings);

  return (<>
    <div className="flex items-center gap-3 mb-2 text-[13px]">
      <a href={`?tab=hiring${showAgencies ? '' : '&agencies=1'}`} className="flex items-center gap-1.5 text-ink2">
        <span className={`inline-block w-8 h-[18px] rounded-full transition-colors ${showAgencies ? 'bg-accent' : 'bg-line'}`}>
          <span className={`block w-3.5 h-3.5 mt-[2px] rounded-full bg-white transition-transform ${showAgencies ? 'translate-x-[16px]' : 'translate-x-[2px]'}`} />
        </span>
        Show agencies
      </a>
      <span className="text-ink3 text-[12px]">
        {hiddenAgencies > 0
          ? `${hiddenAgencies} ${hiddenAgencies === 1 ? 'agency posting' : 'agency postings'} hidden — competitors' vacancies, not customer demand`
          : 'No agency postings in this list'}
        {duplicates > 0 && ` · ${duplicates} board advert${duplicates === 1 ? '' : 's'} repeating a company's own page`}
      </span>
    </div>

    <div className="bg-panel border border-line rounded-card overflow-auto max-h-[calc(100vh-220px)]">
      <table className="tbl w-full min-w-[1100px] border-collapse">
        <thead>
          <tr><th>Company</th><th>Roles open</th><th>Where</th><th>Trades</th><th>Certificates asked for</th><th>Pressure</th><th>Latest</th></tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.company} className="hover:bg-[#F9FAFB] align-top">
              <td>
                <div className="font-medium whitespace-nowrap">{g.company}</div>
                <div className="text-ink3 text-[12px]">
                  {[g.country, g.employerType?.replace(/_/g, ' ')].filter(Boolean).join(' · ')}
                  {g.employerType === 'staffing_agency' && <span className="text-warn"> · agency</span>}
                </div>
                {!g.fromOwnBoard && <div className="text-ink3 text-[12px]">from a job board{g.boardPosters.length ? `, placed by ${g.boardPosters.slice(0, 2).join(', ')}` : ', advertiser not named'}</div>}
              </td>
              <td>
                <div>{g.roles.slice(0, 4).map((r) => `${r.name}${r.n > 1 ? ` ×${r.n}` : ''}`).join(', ')}</div>
                {g.roles.length > 4 && <div className="text-ink3 text-[12px]">+{g.roles.length - 4} more</div>}
                <div className="text-ink3 text-[12px]">{g.postings.length} advert{g.postings.length === 1 ? '' : 's'}</div>
              </td>
              <td className="text-[13px]">
                {g.places.slice(0, 3).join(', ') || g.country || '—'}
                {g.places.length > 3 && <div className="text-ink3 text-[12px]">+{g.places.length - 3} more</div>}
              </td>
              <td>
                {g.trades.map((t) => <span key={t} className="inline-block text-[12px] px-2 py-0.5 rounded-md bg-line2 text-ink2 mr-1 mb-1">{t}</span>)}
                {!g.trades.length && <span className="text-ink3 text-[12px]">—</span>}
              </td>
              <td className="text-[13px]">{g.certs.join(', ') || <span className="text-ink3">none stated</span>}</td>
              <td><Pressure p={g.pressure} /></td>
              <td className="text-[13px] whitespace-nowrap">
                {day(g.newest) ?? <span className="text-ink3">—</span>}
                <div className="text-[12px]">
                  <a href={g.postings[0].source_url} target="_blank" rel="noopener" className="text-accent">Open board</a>
                  <span className="text-ink3"> · via {g.postings[0].via ?? '—'}</span>
                </div>
              </td>
            </tr>
          ))}

          {groups.length === 0 && (
            <tr><td colSpan={7} className="text-ink3 p-6">
              {companiesWithBoards === 0
                ? 'No careers pages found yet. Discovery has not run over the company list.'
                : hiddenAgencies > 0
                  ? `Nothing from an employer. ${hiddenAgencies} agency posting${hiddenAgencies === 1 ? '' : 's'} are hidden — turn on "Show agencies" to see the market view.`
                  : `No trade postings open. ${companiesWithBoards} careers page${companiesWithBoards === 1 ? '' : 's'} are being read${crawledAt ? `, last on ${new Date(crawledAt).toLocaleString('en-GB')}` : ''}; nothing on them is for a trade we place.`}
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  </>);
}

export const HiringHelp = () => (
  <Help
    title="What Hiring now is"
    intro="Trade postings taken from companies' own careers pages — one line per company, not per advert."
    rows={[
      ['Comes from', 'The company\'s own board. Where they use an ATS we read its published list; otherwise the careers page itself.'],
      ['Filtered by', 'Every title is read in its own language and mapped to our trades — industrirørlegger is a pipefitter. Only trades we place are kept.'],
      ['Pressure', 'Volume and recency together: five or more open trade roles in the last month is high; one advert from March is low.'],
      ['Agencies', 'Hidden by default — a staffing agency\'s vacancies are a competitor\'s, not a customer\'s. The toggle shows them when you want the market view.'],
      ['Never', 'Invents a posting, a certificate requirement or a headcount. Everything links back to the board it was read from.'],
    ]}
  />
);
