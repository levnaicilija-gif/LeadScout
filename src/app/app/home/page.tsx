import Link from 'next/link';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { SignOut } from '@/components/SignOut';
import { todayItems, whenLabel, HOW_THIS_LIST_IS_MADE } from '@/lib/today';
import { HomeCards } from '@/components/HomeCards';
import { Logo } from '@/components/Logo';
export const dynamic = 'force-dynamic';

/**
 * Home — design/leadscout-home-v2.html.
 *
 * One card per part of the job, each with counts read live and a single action; the whole card
 * is the link. Every number is a query, and a card that has nothing to report says so rather
 * than showing a plausible figure. No search bar.
 */
export default async function Home() {
  const me = await currentUser();
  const sb = supabaseServer();
  const iso = (n: number) => new Date(Date.now() + n * 86400000).toISOString();
  const date = (n: number) => iso(n).slice(0, 10);
  const today = date(0);

  const [
    items, wonWork, hiringNow, weekOk, weekBad, pool, expiring,
    availableNow, freeSoon, prioritySources, spend, radar,
  ] = await Promise.all([
    todayItems(sb),
    sb.from('leads').select('id', { count: 'exact', head: true }).eq('kind', 'won_work').eq('status', 'new'),
    sb.from('job_posts').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    sb.from('verifications').select('id', { count: 'exact', head: true }).eq('result', 'valid').gte('checked_at', iso(-7)),
    sb.from('verifications').select('id', { count: 'exact', head: true }).in('result', ['invalid', 'not_found']).gte('checked_at', iso(-7)),
    sb.from('candidates').select('id', { count: 'exact', head: true }),
    sb.from('verifications').select('id', { count: 'exact', head: true }).eq('result', 'valid').lte('valid_until', date(60)),
    sb.from('candidates').select('id', { count: 'exact', head: true }).or(`availability_from.is.null,availability_from.lte.${today}`),
    sb.from('candidates').select('id', { count: 'exact', head: true }).gt('availability_from', today).lte('availability_from', date(30)),
    sb.from('sources').select('id', { count: 'exact', head: true }).eq('tier', 'priority').eq('enabled', true),
    sb.from('cost_log').select('eur').eq('day', today),
    sb.from('articles').select('fetched_at').gte('fetched_at', `${today}T00:00:00Z`).order('fetched_at', { ascending: true }),
  ]);

  const spentToday = (spend.data ?? []).reduce((a: number, r: any) => a + Number(r.eur ?? 0), 0);
  const readToday = radar.data?.length ?? 0;
  const firstRead = radar.data?.[0]?.fetched_at
    ? new Date(radar.data[0].fetched_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : null;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const waitingOnIssuers = items.filter((i) => i.from === 'verifications where result = pending').length;
  const newLeadsToRead = wonWork.count ?? 0;
  const freeBy = new Date(Date.now() + 30 * 86400000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

  const Pulse = ({ tone, children }: { tone: 'ok' | 'warn'; children: React.ReactNode }) => (
    <span className="bg-panel border border-line rounded-full px-3.5 py-1.5 text-[13px] text-ink2 inline-flex items-center gap-2">
      <i className={`w-2 h-2 rounded-full ${tone === 'warn' ? 'bg-warn' : 'bg-ok'}`} />{children}
    </span>
  );

  const Nav = ({ href, label, on }: { href: string; label: string; on?: boolean }) => (
    <Link href={href} className={`px-3 py-1.5 rounded font-medium ${on ? 'bg-line2 text-ink' : 'hover:bg-line2/60'}`}>{label}</Link>
  );

  return (
    <div className="min-h-screen bg-bg">
      <div className="bg-panel border-b border-line px-8 h-[60px] flex items-center justify-between sticky top-0 z-10">
        <Link href="/app/home"><Logo size="sm" /></Link>
        <nav className="hidden md:flex gap-1 text-ink2">
          <Nav href="/app/home" label="Home" on />
          <Nav href="/app/today" label="Today" />
          <Nav href="/app/radar" label="Leads" />
          <Nav href="/app/verify" label="Verify" />
          <Nav href="/app/pitch" label="Pitch" />
          <Nav href="/app/candidates" label="Candidates" />
        </nav>
        {/* v4's .who — the initial in a violet disc, the name only where there is room for it. */}
        <span className="text-[13px] text-ink3 flex items-center gap-2.5 min-w-0">
          <span className="w-[30px] h-[30px] rounded-full bg-tool-cand text-white grid place-items-center font-semibold text-[12px] shrink-0">{(me?.name ?? me?.email ?? '?').trim()[0]?.toUpperCase()}</span>
          <span className="hidden sm:inline truncate max-w-[220px]">{me?.name ?? me?.email} · {me?.role}</span>
          <SignOut on="light" />
        </span>
      </div>

      <div className="max-w-[1180px] mx-auto px-7 pt-10 pb-20">
        <div className="flex items-end justify-between mb-6 flex-wrap gap-5">
          <div>
            <h1 className="font-display text-[30px] font-extrabold tracking-[-.6px] m-0">{greeting}, {(me?.name ?? me?.email ?? '').split(' ')[0]}</h1>
            <p className="mt-1.5 m-0 text-ink2 text-[15px]">
              {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
              {readToday > 0 ? ` · Radar read ${readToday} article${readToday === 1 ? '' : 's'}${firstRead ? ` at ${firstRead}` : ''}` : ' · Radar has not run yet today'}
              {newLeadsToRead > 0 && ` · ${newLeadsToRead} new lead${newLeadsToRead === 1 ? '' : 's'} worth calling`}
            </p>
          </div>
          {/* Each pill is one query. A dot is amber only where something is actually waiting. */}
          <div className="flex gap-2.5 flex-wrap">
            <Pulse tone={readToday > 0 ? 'ok' : 'warn'}>Radar <b className="text-ink font-semibold">{readToday > 0 ? 'ran' : 'not run'}</b>{firstRead ? ` ${firstRead}` : ''}</Pulse>
            <Pulse tone="ok">Spent today <b className="text-ink font-semibold">€{spentToday.toFixed(2)}</b></Pulse>
            <Pulse tone={waitingOnIssuers > 0 ? 'warn' : 'ok'}><b className="text-ink font-semibold">{waitingOnIssuers}</b> waiting on issuers</Pulse>
          </div>
        </div>

        <HomeCards
          cards={[
            {
              href: '/app/today', tool: 'today' as const, tone: 'today' as const, icon: 'calendar' as const,
              pill: items.length ? { text: `${items.length} to do`, tone: 'bad' } : { text: 'nothing waiting', tone: 'ok' },
              title: 'Today',
              get: 'Your day in priority order. Calls with the script ready, packs to send, certificates waiting on an issuer. Nothing sent without you.',
              nums: [
                { n: waitingOnIssuers, label: 'waiting on issuers', tone: 'w' },
                { n: newLeadsToRead, label: 'new leads to read' },
              ],
              action: 'Open my day',
            },
            {
              href: '/app/radar', tool: 'leads' as const, tone: 'plain' as const, icon: 'radar' as const,
              pill: newLeadsToRead ? { text: `${newLeadsToRead} new`, tone: 'ok' } : { text: 'none new', tone: '' },
              title: 'Leads',
              get: 'Companies that just won work — with the person quoted by name and the article that proves it — and companies posting trade jobs right now.',
              nums: [
                { n: wonWork.count ?? 0, label: 'won work' },
                { n: hiringNow.count ?? 0, label: (hiringNow.count ?? 0) === 0 ? 'hiring now · crawl pending' : 'hiring now' },
              ],
              action: 'See new leads',
            },
            {
              href: '/app/verify', tool: 'verify' as const, tone: 'plain' as const, icon: 'shield' as const,
              pill: { text: 'drop files', tone: '' },
              title: 'Verify',
              get: 'Drop anything a candidate sends. CVs come back anonymized with three client bullets and a PDF. Certificates are checked with the issuer — what they cover, until when.',
              nums: [
                { n: weekOk.count ?? 0, label: 'certs verified this week', tone: 'g' },
                { n: weekBad.count ?? 0, label: 'caught bad before a client saw them', tone: 'b' },
              ],
              action: 'Drop files',
            },
            {
              href: '/app/pitch', tool: 'pitch' as const, tone: 'plain' as const, icon: 'pitch' as const,
              pill: { text: 'reverse', tone: '' },
              title: 'Pitch',
              get: 'Start from a scarce person. See which companies should hear about them, with a blind teaser drafted for each — reference code only, never a name.',
              nums: [
                { n: availableNow.count ?? 0, label: 'available now' },
                { n: freeSoon.count ?? 0, label: `free by ${freeBy}` },
              ],
              action: 'Pitch someone',
            },
            {
              href: '/app/candidates', tool: 'cand' as const, tone: 'plain' as const, icon: 'people' as const,
              pill: (expiring.count ?? 0) ? { text: `${expiring.count} expiring`, tone: 'warn' } : { text: 'all in date', tone: 'ok' },
              title: 'Candidates',
              get: 'The pool. Who\'s free, who\'s verified, who was sent where. Full names and documents stay here — clients only ever see the anonymized version.',
              nums: [
                { n: pool.count ?? 0, label: 'in pool' },
                { n: expiring.count ?? 0, label: 'certs expiring ≤ 60 days', tone: 'w' },
              ],
              action: 'Search the pool',
            },
            ...(me?.role === 'senior' ? [{
              href: '/app/settings', tool: 'set' as const, tone: 'plain' as const, icon: 'cog' as const,
              pill: { text: 'senior', tone: '' as const },
              title: 'Settings',
              get: 'What Radar reads, how certificates are checked, right-to-work rules by country, where your candidates come from, team and onboarding.',
              nums: [
                { n: prioritySources.count ?? 0, label: 'priority sources' },
                { n: `€${spentToday.toFixed(2)}`, label: 'Radar spent today' },
              ],
              action: 'Open settings',
            }] : []),
          ]}
        />

        <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-[18px] mt-[18px]">
          <div className="bg-panel border border-line rounded-tile px-6 py-[22px]">
            <h3 className="m-0 mb-0.5 text-[17px] font-bold">Today, in order</h3>
            <small className="text-ink3 text-[12px]">A clock time only where a call is actually scheduled</small>
            <ol className="list-none mt-3 m-0 p-0">
              {items.length === 0 && <li className="py-2.5 text-ink3 text-[13.5px]">Nothing waiting. Drop a certificate or a CV into Verify, or wait for Radar at 06:00.</li>}
              {items.slice(0, 6).map((it, i) => (
                <li key={i} className="grid grid-cols-[70px_10px_1fr] gap-2.5 py-2.5 border-t border-line2 first:border-t-0 text-[13.5px]">
                  <span className="text-ink3 text-[12px] whitespace-nowrap">{i + 1} · {whenLabel(it, i)}</span>
                  <span className={`w-2 h-2 rounded-full mt-1.5 ${it.dot === 'warn' ? 'bg-warn' : it.dot === 'bad' ? 'bg-bad' : 'bg-accent'}`} />
                  <div>
                    <b className="block font-medium">{it.title}</b>
                    {it.sub && <span className="text-ink3 text-[12px]">{it.sub}</span>}
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="bg-panel border border-line rounded-tile px-6 py-[22px]">
            <h3 className="m-0 mb-0.5 text-[17px] font-bold">How this list is made</h3>
            <small className="text-ink3 text-[12px]">No AI decides your day. Six queries, fixed order:</small>
            <ol className="list-decimal pl-[18px] mt-2.5 text-[13px] leading-[1.7] text-ink2">
              {HOW_THIS_LIST_IS_MADE.map((q) => <li key={q} className="py-0.5">{q}</li>)}
            </ol>
          </div>
        </div>

        <p className="text-center text-ink3 text-[12px] mt-[34px]">Nothing is invented. Every name, number and date links to the page it came from.</p>
      </div>
    </div>
  );
}
