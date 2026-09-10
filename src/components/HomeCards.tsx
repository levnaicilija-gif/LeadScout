import Link from 'next/link';

/**
 * The Home card grid from design/leadscout-home-v2.html.
 *
 * The whole card is the link — a card with one action does not need a button inside it — and
 * the footer arrow slides on hover as the design does. Today is the dark tile.
 */
export type CardNum = { n: number | string; label: string; tone?: 'w' | 'g' | 'b' };
export type Card = {
  href: string;
  tone: 'today' | 'plain';
  icon: 'calendar' | 'radar' | 'shield' | 'pitch' | 'people' | 'cog';
  iconTone?: 'ok' | 'warn';
  pill: { text: string; tone: 'ok' | 'warn' | 'bad' | '' };
  title: string;
  get: string;
  nums: CardNum[];
  action: string;
};

const ICONS: Record<Card['icon'], React.ReactNode> = {
  calendar: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M8 2v4M16 2v4M3 10h18" /></>,
  radar: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><path d="M12 3v3M21 12h-3M12 21v-3M3 12h3" /></>,
  shield: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" /><path d="M9 12l2 2 4-4" /></>,
  pitch: <path d="M4 20l6-6M14 4l6 6-8 8H8v-4l6-6z" />,
  people: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0113 0" /><circle cx="17" cy="9" r="2.5" /><path d="M15.5 20a5 5 0 016 0" /></>,
  cog: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 01-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 01-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 012.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 012.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z" /></>,
};

const PILL: Record<string, string> = {
  ok: 'bg-oksoft text-ok', warn: 'bg-warnsoft text-warn', bad: 'bg-badsoft text-bad', '': 'bg-line2 text-ink2',
};

export function HomeCards({ cards }: { cards: Card[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[18px]">
      {cards.map((c) => {
        const dark = c.tone === 'today';
        return (
          <Link
            key={c.href}
            href={c.href}
            className={`group relative rounded-[14px] border overflow-hidden flex flex-col min-h-[280px] transition-[transform,box-shadow,border-color] duration-[180ms] hover:-translate-y-[3px] hover:shadow-[0_18px_44px_rgba(14,26,43,.12)] hover:border-[#B9C4D2] ${dark ? 'bg-rail border-rail text-railink' : 'bg-panel border-line'}`}
          >
            <div className="pt-[22px] px-[22px] flex items-start justify-between">
              <div className={`w-[52px] h-[52px] rounded-[14px] grid place-items-center ${dark ? 'bg-white/10 text-white' : c.iconTone === 'ok' ? 'bg-oksoft text-ok' : c.iconTone === 'warn' ? 'bg-warnsoft text-warn' : 'bg-accentsoft text-accent'}`}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">{ICONS[c.icon]}</svg>
              </div>
              <span className={`text-[12px] font-medium rounded-full px-2.5 py-1 ${PILL[c.pill.tone]}`}>{c.pill.text}</span>
            </div>

            <h3 className={`mt-4 mx-[22px] mb-1 text-[19px] font-semibold ${dark ? 'text-white' : ''}`}>{c.title}</h3>
            <div className={`mx-[22px] text-[13.5px] leading-[1.5] ${dark ? 'text-[#AEB9C8]' : 'text-ink2'}`}>{c.get}</div>

            <div className="mt-4 mx-[22px] grid grid-cols-2 gap-2.5">
              {c.nums.map((n) => (
                <div key={n.label}>
                  <b className={`block text-[22px] font-semibold leading-none tracking-[-0.3px] ${dark ? (n.tone === 'w' ? 'text-[#E0B45A]' : 'text-white') : n.tone === 'w' ? 'text-warn' : n.tone === 'g' ? 'text-ok' : n.tone === 'b' ? 'text-bad' : ''}`}>{n.n}</b>
                  <span className={`text-[12px] ${dark ? 'text-[#7D8BA0]' : 'text-ink3'}`}>{n.label}</span>
                </div>
              ))}
            </div>

            <div className={`mt-auto px-[22px] py-3.5 border-t flex justify-between items-center text-[13px] font-medium ${dark ? 'bg-rail2 border-white/10 text-white' : 'bg-[#FAFBFC] border-line2 text-accent'}`}>
              {c.action}
              <i className="not-italic transition-transform duration-[180ms] group-hover:translate-x-1">→</i>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
