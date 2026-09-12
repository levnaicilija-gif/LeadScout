import Link from 'next/link';
import { STRIPE, TILE, PILL as TOOLPILL, ACTION, type Tool } from '@/lib/tool-colour';

/**
 * The Home card grid — design/leadscout-design-v4.html.
 *
 * Each card is one part of the job in its own colour: the stripe across the top, the icon tile,
 * the pill and the action button all take it, so the card can be recognised before it is read.
 * The colour says which tool; it never says how things are going — a pill reporting a state
 * (expiring, caught bad, nothing waiting) drops the tool colour and takes the status one.
 *
 * The whole card is the link — a card with one action does not need a button inside it — and the
 * arrow slides on hover as the design does. Today is the dark tile.
 */
export type CardNum = { n: number | string; label: string; tone?: 'w' | 'g' | 'b' };
export type Card = {
  href: string;
  tool: Tool;
  tone: 'today' | 'plain';
  icon: 'calendar' | 'radar' | 'shield' | 'pitch' | 'people' | 'cog';
  pill: { text: string; tone: 'ok' | 'warn' | 'bad' | '' };
  title: string;
  get: string;
  nums: CardNum[];
  action: string;
};

const ICONS: Record<Card['icon'], React.ReactNode> = {
  calendar: <><rect x="3" y="4" width="18" height="17" rx="3" /><path d="M8 2v4M16 2v4M3 10h18M8 15h4" /></>,
  radar: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.5" /><path d="M12 12l6-6" /></>,
  shield: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" /><path d="M9 12l2 2 4-4" /></>,
  pitch: <path d="M4 20l6-6M14 4l6 6-8 8H8v-4l6-6z" />,
  people: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0113 0" /><circle cx="17" cy="9" r="2.5" /><path d="M15.5 20a5 5 0 016 0" /></>,
  cog: <><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 01-.1 1.2l2 1.6-2 3.4-2.4-1a7 7 0 01-2 1.2L14 21h-4l-.5-2.6a7 7 0 01-2-1.2l-2.4 1-2-3.4 2-1.6A7 7 0 015 12a7 7 0 01.1-1.2l-2-1.6 2-3.4 2.4 1a7 7 0 012-1.2L10 3h4l.5 2.6a7 7 0 012 1.2l2.4-1 2 3.4-2 1.6c.06.4.1.8.1 1.2z" /></>,
};

/** A pill that reports a state takes the status colour; one that just labels the tool does not. */
const STATUS: Record<string, string> = {
  ok: 'bg-oksoft text-ok', warn: 'bg-warnsoft text-warn', bad: 'bg-badsoft text-bad',
};
const DARK_STATUS: Record<string, string> = {
  ok: 'bg-white/[.12] text-[#6FD3A3]', warn: 'bg-white/[.12] text-[#F0B454]', bad: 'bg-white/[.12] text-[#F09292]',
};

export function HomeCards({ cards }: { cards: Card[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
      {cards.map((c) => {
        const dark = c.tone === 'today';
        const pill = c.pill.tone
          ? (dark ? DARK_STATUS[c.pill.tone] : STATUS[c.pill.tone])
          : TOOLPILL[c.tool];
        return (
          <Link
            key={c.href}
            href={c.href}
            className={`group relative rounded-tile border overflow-hidden flex flex-col min-h-[290px] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[0_24px_50px_rgba(14,26,43,.14)] ${dark ? 'bg-rail border-rail text-railink' : 'bg-panel border-line'}`}
          >
            <span className={`absolute inset-x-0 top-0 h-1.5 ${STRIPE[c.tool]}`} />

            <div className="pt-[26px] px-6 pb-2 flex flex-col gap-3 flex-1">
              <div className={`w-[58px] h-[58px] rounded-[16px] grid place-items-center ${TILE[c.tool]}`}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">{ICONS[c.icon]}</svg>
              </div>
              <span className={`absolute top-[22px] right-[22px] text-[12px] font-semibold rounded-full px-2.5 py-1 ${pill}`}>{c.pill.text}</span>

              <h3 className={`font-display mt-1.5 mb-0 text-[21px] font-bold tracking-[-.3px] ${dark ? 'text-white' : ''}`}>{c.title}</h3>
              <p className={`m-0 text-[14px] leading-[1.55] ${dark ? 'text-[#AEB9C8]' : 'text-ink2'}`}>{c.get}</p>

              <div className="grid grid-cols-2 gap-2.5 mt-auto pt-2.5">
                {c.nums.map((n) => (
                  <div key={n.label}>
                    <b className={`block font-display text-[24px] font-extrabold leading-none tracking-[-.4px] ${dark ? (n.tone === 'w' ? 'text-[#F0B454]' : 'text-white') : n.tone === 'w' ? 'text-warn' : n.tone === 'g' ? 'text-ok' : n.tone === 'b' ? 'text-bad' : ''}`}>{n.n}</b>
                    <span className={`text-[12px] ${dark ? 'text-[#7D8BA0]' : 'text-ink3'}`}>{n.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <span className={`mx-6 mt-3 mb-5 inline-flex items-center gap-2 rounded px-3.5 py-2.5 font-semibold text-[14px] w-max transition-[gap] duration-200 group-hover:gap-3.5 ${ACTION[c.tool]}`}>
              {c.action}<i className="not-italic">→</i>
            </span>
          </Link>
        );
      })}
    </div>
  );
}
