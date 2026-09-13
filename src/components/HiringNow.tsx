import { Help } from './Help';
import { OpenRow, OpenChevron } from './OpenRow';
import { postingAge, reAdverts, roleKey, ageSink, latestActivityCompare, AGE_TEXT, AGE_DIM, REPOST_WINDOW_DAYS, type Age } from '@/lib/lead-age';

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
  companyId: string;
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
  /** Why that word — shown on hover, so the ranking is never a number nobody can question. */
  pressureWhy: string;
  openings: number;
  reposted: number;
  daysSinceNewest: number | null;
  /** Item 17: as old as the newest advert. Informational — it sinks and dims the row, never hides it. */
  age: Age;
  /** Roles advertised again on another day inside the repost window, most first. */
  readvertised: { role: string; count: number; days: string[] }[];
  /** A role re-advertised often enough to raise the row above the others. */
  boosted: boolean;
};

const day = (s?: string | null) => (s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null);

// roleKey — two "Servicemonteur" adverts in two towns are one role hiring twice — lives in
// src/lib/lead-age.ts, because re-advertising is counted per role too.

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

    // Re-advertised means the same role again on a different day inside the window (src/lib/lead-age.ts).
    // Several adverts for one role on one day are openings at once: this used to count wet pro's three
    // same-day adverts and AIBEL's two as reposts and call the roles "not filled".
    const byRole = new Map<string, Posting[]>();
    for (const p of ps) { const k = roleKey(p) || 'Trade role'; byRole.set(k, [...(byRole.get(k) ?? []), p]); }
    const readvertised = [...byRole.entries()]
      .map(([role, list]) => ({ role, ...reAdverts(list) }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count);
    const reposted = readvertised.reduce((n, r) => n + r.count, 0);
    const boosted = readvertised.some((r) => r.boosted);
    // A row is as old as its newest advert; an advert with no date at all never makes it older.
    const age = ps.map((p) => postingAge(p)).sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity))[0];
    const days = newest ? Math.floor((Date.now() - Date.parse(newest)) / 86400000) : null;
    const pressure: Group['pressure'] = openings >= 5 && fresh ? 'high' : openings >= 5 || (openings >= 2 && fresh) ? 'medium' : 'low';

    return {
      companyId: ps[0].company_id,
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
      pressure,
      openings,
      reposted,
      daysSinceNewest: days,
      age,
      readvertised: readvertised.map(({ role, count, days: on }) => ({ role, count, days: on })),
      boosted,
      pressureWhy: [
        `${openings} opening${openings === 1 ? '' : 's'} across ${ps.length} advert${ps.length === 1 ? '' : 's'}`,
        ...readvertised.map((r) => `${r.role} re-advertised ${r.count}× in ${REPOST_WINDOW_DAYS} days (${r.days.join(', ')})${r.boosted ? ' — priority raised' : ''}`),
        days === null ? 'no date on any advert' : days <= 30 ? `newest ${days} day${days === 1 ? '' : 's'} old` : `newest is ${days} days old`,
      ].filter(Boolean).join(' · '),
    };
  });

  const rank = { high: 0, medium: 1, low: 2 };
  // Re-advertised rows first, ageing rows last (src/lib/lead-age.ts#ageSink), then pressure as before.
  return groups.sort((a, b) =>
    ageSink(a.age.state, a.boosted) - ageSink(b.age.state, b.boosted)
    || rank[a.pressure] - rank[b.pressure]
    || b.postings.length - a.postings.length
    || (b.newest ?? '').localeCompare(a.newest ?? ''));
}

const Pressure = ({ p }: { p: Group['pressure'] }) => (
  <span className={`st ${p === 'high' ? 'st-bad' : p === 'medium' ? 'st-warn' : ''}`}>{p}</span>
);

export function HiringNow({
  postings, crawledAt, companiesWithBoards, showAgencies, hiddenAgencies, duplicates = 0,
  filters, options, state, rightToWork,
}: {
  postings: Posting[];
  crawledAt?: string | null;
  companiesWithBoards: number;
  showAgencies: boolean;
  hiddenAgencies: number;
  /** Board adverts that repeat a company's own careers page, dropped from the view. */
  duplicates?: number;
  /** What the page is currently filtered to, straight from the query string. */
  filters?: { country?: string; trade?: string; employer?: string; pressure?: string; sort?: string };
  /** Every value present in the unfiltered data, so a chip is never offered for nothing. */
  options?: { countries: string[]; trades: string[]; employers: string[] };
  /** Per company: confirmed, pursued, not for us. */
  state?: Record<string, { confirmedAt?: string | null; status?: string | null }>;
  /** The rule for a job in that country — one line, keyed on where the work is. */
  rightToWork?: Record<string, string>;
}) {
  const all = groupByCompany(postings);
  const f = filters ?? {};
  const groups = all.filter((g) =>
    (!f.country || g.country === f.country)
    && (!f.trade || g.trades.includes(f.trade))
    && (!f.employer || (g.employerType ?? 'unknown') === f.employer)
    && (!f.pressure || g.pressure === f.pressure));
  // ?sort=latest — "Latest activity": a re-advertised row keeps its place at the top whatever the sort, then
  // Fresh, Ageing, Stale, Age unknown by the newest advert, newest first within each, then pressure.
  // Without it the order is groupByCompany's: re-advertised first, ageing last, then pressure.
  const PRESSURE_RANK = { high: 0, medium: 1, low: 2 };
  if (f.sort === 'latest') {
    groups.sort((a, b) => (Number(b.boosted) - Number(a.boosted))
      || latestActivityCompare(a.age, b.age)
      || PRESSURE_RANK[a.pressure] - PRESSURE_RANK[b.pressure]
      || b.postings.length - a.postings.length);
  }
  const sortQs = f.sort === 'latest' ? '&sort=latest' : '';

  return (<>
    <div className="flex items-center gap-3 mb-2 text-[13px]">
      <a href={`?tab=hiring${showAgencies ? '' : '&agencies=1'}${sortQs}`} className="flex items-center gap-1.5 text-ink2">
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

    {options && <Chips options={options} filters={f} showAgencies={showAgencies} shown={groups.length} total={all.length} />}

    <div data-sort-control className="flex items-center gap-1.5 flex-wrap mb-2 text-[13px]">
      <span className="text-ink3">Sort</span>
      {([[false, 'Pressure'], [true, 'Latest activity']] as const).map(([isLatest, label]) => {
        // Every filter and the agencies toggle survive a change of sort.
        const q = new URLSearchParams({ tab: 'hiring' });
        if (showAgencies) q.set('agencies', '1');
        for (const [k, v] of Object.entries({ country: f.country, trade: f.trade, employer: f.employer, pressure: f.pressure })) if (v) q.set(k, v);
        if (isLatest) q.set('sort', 'latest');
        const on = (f.sort === 'latest') === isLatest;
        return <a key={label} data-sort={isLatest ? 'latest' : 'pressure'} href={`?${q.toString()}`} className={`chip ${on ? '!bg-rail !text-white !border-rail' : ''}`}>{label}</a>;
      })}
      {f.sort === 'latest' && <span className="text-ink3 text-[12px]">Re-advertised first, then fresh, ageing, stale and age unknown — newest advert first within each</span>}
    </div>

    <div data-drawer-help className="text-[13px] mb-2">
      <span className="text-ink3">Click or tap a company to open its drawer</span>
      <Help
        title="What opens when you click a company"
        intro="The company's drawer: who to contact — a named person, the switchboard or a general email, each with the page it came from — and its employer type, with the evidence and your override. Below that, its postings, the four tools (job description, score the pool, LinkedIn search, screening questions), a drafted email that says whether sending is on yet, and Confirm, Pursue or Not for us."
      />
    </div>

    <div className="bg-panel border border-line rounded-card overflow-auto max-h-[calc(100vh-220px)]">
      <table className="tbl w-full min-w-[1100px] border-collapse">
        <thead>
          <tr><th>Company</th><th>Roles open</th><th>Where</th><th>Trades</th><th>Certificates asked for</th><th>Pressure</th><th>Latest</th></tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <OpenRow key={g.company} href={`/app/radar?tab=hiring&company=${g.companyId}${showAgencies ? '&agencies=1' : ''}${sortQs}`} className={`align-top ${g.boosted ? '' : AGE_DIM[g.age.state]}`} attrs={{ 'data-age': g.age.state, 'data-age-date': g.age.date ?? '', ...(g.boosted ? { 'data-boosted': 'true' } : {}) }}>
              <td>
                <a href={`?tab=hiring&company=${g.companyId}${showAgencies ? '&agencies=1' : ''}${sortQs}`} className="flex items-center gap-1.5 font-medium whitespace-nowrap text-accent">{g.company}<OpenChevron /></a>
                <div className="text-ink3 text-[12px]">
                  {[g.country, g.employerType?.replace(/_/g, ' ')].filter(Boolean).join(' · ')}
                  {g.employerType === 'staffing_agency' && <span className="text-warn"> · agency</span>}
                </div>
                <div data-age-label title={g.age.why} className={`text-[12px] ${AGE_TEXT[g.age.state]}`}>{g.age.label}</div>
                {g.boosted && <span data-boosted-label title={g.pressureWhy} className="badge badge-info mt-1 mr-1">re-advertised {g.readvertised[0].count}× — priority raised</span>}
                {state?.[g.companyId]?.status === 'pursued' && <span className="badge badge-info mt-1">pursued</span>}
                {state?.[g.companyId]?.confirmedAt && <span className="badge badge-ok mt-1 ml-1">✓ checked</span>}
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
                {g.country && rightToWork?.[g.country] && <div className="text-ink3 text-[12px] mt-0.5">{rightToWork[g.country]}</div>}
              </td>
              <td>
                {g.trades.map((t) => <span key={t} className="inline-block text-[12px] px-2 py-0.5 rounded-md bg-line2 text-ink2 mr-1 mb-1">{t}</span>)}
                {!g.trades.length && <span className="text-ink3 text-[12px]">—</span>}
              </td>
              <td className="text-[13px]">{g.certs.join(', ') || <span className="text-ink3">none stated</span>}</td>
              <td title={g.pressureWhy}>
                <Pressure p={g.pressure} />
                <div className="text-ink3 text-[12px]">{g.openings} open{g.reposted > 0 ? ` · re-advertised ${g.reposted}×` : ''}</div>
              </td>
              <td className="text-[13px] whitespace-nowrap">
                {day(g.newest) ?? <span className="text-ink3">—</span>}
                <div className="text-[12px]">
                  <a href={g.postings[0].source_url} target="_blank" rel="noopener" className="text-accent">Open board</a>
                  <span className="text-ink3"> · via {g.postings[0].via ?? '—'}</span>
                </div>
              </td>
            </OpenRow>
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
      ['Age', 'A company is ageing when its newest advert is 60 days old — from the posting date, else the day we first saw it. It sinks and dims; it is never hidden. Several adverts on one day are openings, not reposts.'],
      ['Re-advertised', 'The same role advertised again on another day. Twice or more inside 180 days raises the company to the top: a role that keeps coming back is demand, not a stale advert.'],
      ['Agencies', 'Hidden by default — a staffing agency\'s vacancies are a competitor\'s, not a customer\'s. The toggle shows them when you want the market view.'],
      ['Never', 'Invents a posting, a certificate requirement or a headcount. Everything links back to the board it was read from.'],
    ]}
  />
);

/**
 * Filter chips, built from what is actually in the data.
 *
 * A chip is never offered for a value no row has: an empty filter that returns nothing teaches
 * a recruiter that the filters are broken. The counts say how much the current filter is
 * hiding, because a filtered table that looks like the whole table is how a company gets
 * missed for a week.
 */
function Chips({
  options, filters, showAgencies, shown, total,
}: {
  options: { countries: string[]; trades: string[]; employers: string[] };
  filters: { country?: string; trade?: string; employer?: string; pressure?: string; sort?: string };
  showAgencies: boolean;
  shown: number;
  total: number;
}) {
  const href = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams({ tab: 'hiring' });
    if (showAgencies) q.set('agencies', '1');
    const next = { ...filters, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    return `?${q.toString()}`;
  };

  const Row = ({ label, name, values }: { label: string; name: keyof typeof filters; values: string[] }) => {
    if (values.length < 2) return null;
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-ink3 text-[12px] w-[74px] shrink-0">{label}</span>
        {values.map((v) => {
          const on = filters[name] === v;
          return (
            <a key={v} href={href({ [name]: on ? undefined : v })}
              className={`text-[12px] px-2.5 py-1 rounded-full border ${on ? 'border-accent bg-accentsoft text-accent font-semibold' : 'border-line bg-panel text-ink2'}`}>
              {v.replace(/_/g, ' ')}{on ? ' ×' : ''}
            </a>
          );
        })}
      </div>
    );
  };

  const any = filters.country || filters.trade || filters.employer || filters.pressure;
  return (
    <div className="bg-panel border border-line rounded-card px-3.5 py-3 mb-2.5 grid gap-2">
      <Row label="Country" name="country" values={options.countries} />
      <Row label="Trade" name="trade" values={options.trades} />
      <Row label="Employer" name="employer" values={options.employers} />
      <Row label="Pressure" name="pressure" values={['high', 'medium', 'low']} />
      {any && (
        <div className="text-[12px] text-ink2">
          Showing {shown} of {total} companies · <a href={href({ country: undefined, trade: undefined, employer: undefined, pressure: undefined })} className="text-accent font-semibold">clear the filters</a>
        </div>
      )}
    </div>
  );
}
