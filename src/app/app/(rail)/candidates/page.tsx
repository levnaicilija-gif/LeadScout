import Link from 'next/link';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { Help } from '@/components/Help';
import { hasCandidateCrm } from '@/lib/schema-features';
import { loadPool, filterPool } from '@/lib/candidate-pool';
import { STAGES, STAGE_LABEL, PREFERENCES, PREFERENCE_LABEL } from '@/lib/candidate-stages';
import { describe } from '@/lib/candidate-search';
import { candidateLabel } from '@/lib/candidate-number';
import { CandidateBoard, type BoardCard } from '@/components/CandidateBoard';
import { CandidateTableStage } from '@/components/CandidateTableStage';
export const dynamic = 'force-dynamic';

/**
 * Candidates — the pool as a simple CRM (item 24): one list, two views on the same rows (a table and a kanban), a boolean
 * search, and filters for Mine, stage and employment preference. SENSITIVE PERSONAL DATA: everything is read with the
 * signed-in user's client, so row-level security decides who sees whom (every recruiter the whole pool — owner's decision).
 *
 * The number shown is the reference code's own (RFBT-P-0004 is #4); the code stays visible beneath it, because public
 * links, PDF names and old notes still use it. Before 0035 there are no stages, preferences or placements to show, and
 * the page says so rather than showing everybody as "New" as if that had been decided.
 */
type Params = { q?: string; ref?: string; view?: string; mine?: string; stage?: string; pref?: string };

export default async function Candidates({ searchParams }: { searchParams: Params }) {
  const me = await currentUser();
  const sb = supabaseServer();
  const crm = await hasCandidateCrm(sb);
  const view = searchParams.view === 'kanban' ? 'kanban' : 'table';
  // Today's expiry lines link here as ?ref=<code>: that is an exact search for the code.
  const q = searchParams.q ?? (searchParams.ref ? `"${searchParams.ref}"` : '');
  const mine = searchParams.mine === '1';
  const stage = (STAGES as readonly string[]).includes(searchParams.stage ?? '') ? searchParams.stage : undefined;
  const pref = (PREFERENCES as readonly string[]).includes(searchParams.pref ?? '') ? searchParams.pref : undefined;

  const pool = await loadPool(sb, crm);
  const found = filterPool(pool.rows, { q, mine, stage, preference: pref }, { id: me?.id ?? '' });

  const link = (over: Partial<Params>) => {
    const p = new URLSearchParams();
    const merged: Params = { q: q || undefined, view, mine: mine ? '1' : undefined, stage, pref, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/app/candidates${s ? `?${s}` : ''}`;
  };
  // UTC, the same day boundary cert-availability and the expiry alerts use — so a certificate does not
  // read expired here and in date there for an hour either side of midnight.
  const todayIso = new Date().toISOString().slice(0, 10);
  const chip = (on: boolean) => `px-2.5 py-1 rounded-full border text-[12.5px] ${on ? 'bg-rail text-white border-rail' : 'bg-panel border-line text-ink2 hover:border-accent'}`;

  const current = (r: (typeof found.rows)[number]) => r.placements.find((p) => !p.endedOn)?.client ?? null;
  const cards: BoardCard[] = found.rows.map((r) => ({
    id: r.id, label: candidateLabel(r.reference), reference: r.reference, name: r.name, trade: r.trade, country: r.country,
    preference: r.preference, stage: r.stage, certificates: r.certificates.length, placedAt: current(r), href: `/app/candidates/${r.id}`,
  }));

  return (<>
    <div className="flex items-baseline justify-between flex-wrap gap-x-3 gap-y-1 mb-3">
      <h1 className="font-display text-[26px] font-bold tracking-[-.4px]">Candidates<Help title="What Candidates is" intro="The pool. Full name, phone and documents stay here, internal only." rows={[
        ['Adding someone', 'Drop a CV on "Drop a CV here" at the foot of the menu (or anywhere in the app), or click it to browse — on a phone, press + Add CV. Someone who looks like a person already here is asked about, never merged.'],
        ['Search', 'AND, OR, NOT, parentheses and "quoted phrases" — across number, name, trade, country, certificates, preference, notes, CVs sent and placements.'],
        ['Stages', 'New, Screening, Presented, Placed, Bench. Placed records the client and the date.'],
        ['Reveal', 'Releasing a full profile to a client is an explicit, logged action.'],
      ]} /></h1>
      <span className="text-ink3" data-pool-count>{pool.error ? 'could not read the pool' : `${found.rows.length} of ${pool.rows.length}`}</span>
    </div>

    {pool.error && <div className="bg-panel border border-bad rounded-card p-4 mb-3 text-[13px]">
      <b className="text-bad">The pool could not be read, so this page is not showing what is in it.</b>
      <div className="text-ink2 mt-1">Nothing is lost — this is a query fault, not missing candidates.</div>
      <details className="mt-1 text-[12px] text-ink3"><summary className="cursor-pointer">Technical detail</summary><pre className="whitespace-pre-wrap mt-1">{pool.error}</pre></details>
    </div>}

    <form className="grid gap-1.5 mb-3" action="/app/candidates">
      <div className="flex gap-2">
        <input name="q" defaultValue={q} data-candidate-search placeholder={'welder AND (norway OR denmark) AND NOT "level 1"'} className="flex-1 min-w-0 border border-line rounded px-3 py-2 bg-panel" />
        {view === 'kanban' && <input type="hidden" name="view" value="kanban" />}
        {mine && <input type="hidden" name="mine" value="1" />}
        {stage && <input type="hidden" name="stage" value={stage} />}
        {pref && <input type="hidden" name="pref" value={pref} />}
        <button className="btn btn-primary">Search</button>
      </div>
      {found.error
        ? <div data-search-error className="text-bad text-[13px]">Can&apos;t read that search: {found.error}. Use AND, OR, NOT, parentheses and &quot;quoted phrases&quot;.</div>
        : q ? <div data-search-understood className="text-ink3 text-[12.5px]">Searching for {describe(found.query)} · {found.rows.length} found in {Math.max(1, Math.round(found.ms))} ms</div>
          : <div className="text-ink3 text-[12.5px]">AND · OR · NOT · ( ) · &quot;phrase&quot; — number, name, trade, country, certificates, preference, notes, CVs sent, placements</div>}
    </form>

    <div className="flex flex-wrap gap-2 items-center mb-3">
      <span className="inline-flex border border-line rounded-full overflow-hidden text-[12.5px]" data-view-toggle>
        <Link href={link({ view: undefined })} className={`px-3 py-1 ${view === 'table' ? 'bg-rail text-white' : 'bg-panel text-ink2'}`}>Table</Link>
        <Link href={link({ view: 'kanban' })} className={`px-3 py-1 ${view === 'kanban' ? 'bg-rail text-white' : 'bg-panel text-ink2'}`}>Kanban</Link>
      </span>
      <Link href={link({ mine: mine ? undefined : '1' })} className={chip(mine)} data-filter-mine>Mine</Link>
      {crm && STAGES.map((s) => <Link key={s} href={link({ stage: stage === s ? undefined : s })} className={chip(stage === s)} data-filter-stage={s}>{STAGE_LABEL[s]}</Link>)}
      {crm && PREFERENCES.map((p) => <Link key={p} href={link({ pref: pref === p ? undefined : p })} className={chip(pref === p)} data-filter-pref={p}>{PREFERENCE_LABEL[p]}</Link>)}
    </div>
    {!crm && <div className="text-ink3 text-[12.5px] mb-3">Stages, employment preference and placements arrive with migration 0035, which is not applied yet — until then nobody has a stage.</div>}

    {view === 'kanban' ? (
      <CandidateBoard cards={cards} enabled={crm} />
    ) : (
      <div className="bg-panel border border-line rounded-card overflow-x-auto">
        <table className="tbl w-full min-w-[1080px] border-collapse">
          <thead><tr><th>#</th><th>Name</th><th>Trade</th><th>Based in</th><th>Stage</th><th>Preference</th><th>Certificates</th><th>CV sent to</th><th>Placed at</th><th>Available</th></tr></thead>
          <tbody>
            {found.rows.map((r) => (
              <tr key={r.id} data-candidate-row={r.id}>
                <td><div className="font-semibold whitespace-nowrap">{candidateLabel(r.reference)}</div><div className="text-ink3 text-[11px] whitespace-nowrap">{r.reference}</div></td>
                <td><Link href={`/app/candidates/${r.id}`} className="text-ink hover:text-accent font-medium" data-candidate-link={r.id}>{r.name ?? 'name not printed'}</Link></td>
                <td>{r.trade ?? '—'}</td>
                <td>{r.country ?? (r.nationality ? <span className="text-ink3">{r.nationality} (nationality)</span> : '—')}</td>
                <td>{crm ? <CandidateTableStage candidate={{ id: r.id, name: r.name, stage: r.stage, placedAt: current(r) }} /> : <span className="text-ink3">—</span>}</td>
                <td>{r.preference ? PREFERENCE_LABEL[r.preference] : '—'}</td>
                {/* A certificate past its issuer date is marked here, because the list is where a
                    recruiter picks somebody for a call. It says "expired" and names the date, and
                    NOT "unavailable": without a role in front of you, unavailable is a claim nobody
                    can check — the same certificate that rules them out of welding to it rules them
                    out of nothing else (src/lib/cert-availability.ts). */}
                <td data-lapsed={r.lapsed.length || undefined}>
                  {r.certificates.length
                    ? r.certificates.map((c, i) => {
                      const gone = !!c.validUntil && c.validUntil < todayIso;
                      return (
                        <span key={i} className={`st mr-2 text-[12.5px] ${gone ? 'text-bad' : ''}`} title={gone ? 'Expired — cannot be sent to a client until it is renewed' : undefined}>
                          {c.body}{c.level ? ` ${c.level}` : ''}{c.validUntil ? ` · ${gone ? 'expired ' : ''}${c.validUntil}` : ''}
                        </span>
                      );
                    })
                    : <span className="text-ink3">none on file</span>}
                </td>
                <td>{r.sentTo.filter((s) => s.kind === 'sent').map((s) => s.client).join(', ') || '—'}</td>
                <td>{current(r) ?? '—'}</td>
                <td>{r.availableFrom ?? '—'}</td>
              </tr>
            ))}
            {!pool.error && found.rows.length === 0 && <tr><td colSpan={10} className="p-6 text-ink3">{pool.rows.length === 0 ? 'No candidates yet. Drop a CV on "Drop a CV here" at the foot of the menu, or click it to browse — on a phone, press + Add CV.' : found.error ? 'Fix the search above to see results.' : 'Nobody matches this search and these filters.'}</td></tr>}
          </tbody>
        </table>
      </div>
    )}
  </>);
}
