/**
 * The LeadScout mark — design/leadscout-design-v4.html.
 *
 * Two rings and a sweep to the north-east: a radar finding one thing, which is what the product
 * does every morning. The sweep and the centre are the only parts in teal, so the mark still
 * reads at 20px and in a browser tab.
 */
export function LogoMark({ className = 'w-[34px] h-[34px]', light = false }: { className?: string; light?: boolean }) {
  return (
    <span className={`${className} rounded-[9px] grid place-items-center shrink-0 ${light ? 'bg-white/[.12] border border-white/20' : 'bg-rail'}`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" className="w-[65%] h-[65%]">
        <circle cx="12" cy="12" r="8" strokeOpacity=".35" />
        <circle cx="12" cy="12" r="4" strokeOpacity=".6" />
        <path d="M12 12L18.5 5.5" stroke="#0FA3A3" strokeWidth="2.5" />
        <circle cx="12" cy="12" r="1.6" fill="#0FA3A3" stroke="none" />
      </svg>
    </span>
  );
}

export function Logo({ light = false, size = 'md' }: { light?: boolean; size?: 'sm' | 'md' }) {
  const mark = size === 'sm' ? 'w-7 h-7' : 'w-[34px] h-[34px]';
  const word = size === 'sm' ? 'text-[16px]' : 'text-[18px]';
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark className={mark} light={light} />
      <b className={`font-display font-extrabold tracking-[-.3px] ${word} ${light ? 'text-white' : 'text-rail'}`}>
        Lead<span className="text-tool-radar">Scout</span>
      </b>
    </span>
  );
}
