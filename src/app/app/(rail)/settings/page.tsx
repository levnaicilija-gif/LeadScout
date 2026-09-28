import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { allRows } from '@/lib/all-rows';
import { CandidateCountries } from '@/components/CandidateCountries';
import { CertLibrary } from '@/components/CertLibrary';
import { hasCandidateCountries, hasIndustryFollow, hasScorecards } from '@/lib/schema-features';
import { DailyTargets } from '@/components/DailyTargets';
import { TeamScorecards } from '@/components/TeamScorecards';
import { TeamIndustries } from '@/components/TeamIndustries';
import { FOLLOW_OPTIONS } from '@/lib/industry';
export const dynamic = 'force-dynamic';
export default async function Settings() {
  const me = await currentUser(); if (me?.role !== 'senior') redirect('/app/today');
  const sb = supabaseServer();
  // THE ERROR IS READ AND THE CEILING IS GONE (2026-09-28). Two defects on one line, so both are fixed at
  // once rather than the line being touched twice. (1) An unread error rendered an EMPTY sources list, which
  // is a screen reporting an absence it never checked — the Candidates "No candidates yet" defect. (2) The
  // read was .limit(700) against 610 real rows, 13% of headroom, and PostgREST caps a single read at 1,000
  // regardless of what .limit() asks for, so it was two growth spurts from truncating in silence. allRows
  // pages properly and reads its own error.
  // allRows takes a FUNCTION and the arrow rebuilds the query per page on purpose: a PostgREST builder is
  // mutable and returns itself, so reusing one object would append a duplicate .order() on every iteration
  // (CLAUDE.md records that trap in resolve-domains' own paging).
  const { data, error: sourcesError } = await allRows<any>((from, to) =>
    sb.from('sources').select('*').order('type').order('name').range(from, to));
  const ccReady = await hasCandidateCountries(sb);
  const followReady = await hasIndustryFollow(sb);
  const scorecardsReady = await hasScorecards(sb);
  const { data: ws } = ccReady ? await sb.from('workspaces').select('candidate_countries').eq('id', me.workspace_id).maybeSingle() : { data: null as any };
  return (<><h1 className="font-display text-[26px] font-bold tracking-[-.4px] mb-1">Settings</h1>
    {ccReady && <CandidateCountries initial={ws?.candidate_countries ?? []} />}
    {followReady && <>
      <h2 className="font-display text-[18px] font-bold mb-1 mt-6">What the team follows</h2>
      <p className="text-ink3 mb-3 max-w-[75ch]">The industries each member opens Leads, Hiring now and Today on. You can adjust a member&apos;s choice for them; how many they may follow is set on their account, not by who edits it.</p>
      <TeamIndustries options={FOLLOW_OPTIONS.map((o) => ({ id: o.id, label: o.label }))} />
    </>}
    {scorecardsReady && <>
      <h2 className="font-display text-[18px] font-bold mb-1 mt-6">Daily targets</h2>
      <p className="text-ink3 mb-3 max-w-[75ch]">What a day is expected to hold. A line with a target reads &ldquo;3 of 5&rdquo; on the scorecard; a line left empty shows the count on its own. Nothing here praises or judges — that is for your own reply on someone&apos;s day.</p>
      <DailyTargets />

      <h2 className="font-display text-[18px] font-bold mb-1 mt-6">The team&apos;s days</h2>
      <p className="text-ink3 mb-3 max-w-[75ch]">Days someone has written up. Open one to read their lines beside the counts, and answer in your own words — the reply is yours, not generated.</p>
      <TeamScorecards />
    </>}

    <h2 className="font-display text-[18px] font-bold mb-1 mt-6">Certificate library</h2>
    <p className="text-ink3 mb-3">What each certificate means, what it covers and what it does not. Read on every certificate card and on the client pack. Decoded in code — no model is asked.</p>
    <CertLibrary senior={me?.role === 'senior'} />

    <h2 className="font-display text-[18px] font-bold mb-1">Sources</h2><p className="text-ink3 mb-3">What Radar reads every morning. Admin only. Seeded from seeds/sources.csv via <code>npm run seed</code>.</p>
    <div className="bg-panel border border-line rounded-card overflow-auto max-h-[75vh]"><table className="tbl w-full"><thead><tr><th>Source</th><th>Type</th><th>Region</th><th>Access</th><th>Last read</th><th>Enabled</th></tr></thead><tbody>{sourcesError && <tr><td colSpan={6} className="text-bad">The sources could not be read ({sourcesError.message}) — this list is incomplete. Reload the page.</td></tr>}{(data ?? []).map((s: any) => <tr key={s.id}><td><div className="font-medium">{s.name ?? s.url}</div><div className="text-ink3 text-[12px]">{s.url}</div></td><td>{s.type}</td><td>{s.region}</td><td>{s.paywalled ? 'Paywall · headlines' : 'Open'}</td><td>{s.last_crawled_at ? new Date(s.last_crawled_at).toLocaleString() : '—'}</td><td>{s.enabled ? 'On' : 'Off'}</td></tr>)}</tbody></table></div></>);
}
