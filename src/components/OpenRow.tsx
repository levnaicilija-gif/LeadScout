'use client';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * A table row that opens its drawer from anywhere on the row, not only from the company link.
 *
 * The link in the first cell stays the real target — keyboard, middle-click and "open in new tab"
 * all use it — and a click on another link or button in the row keeps doing its own thing
 * ("Open source", "Open board", the in/G searches). Selecting text is not a click.
 */
export function OpenRow({ href, selected, className = '', attrs, children }: {
  href: string;
  selected?: boolean;
  className?: string;
  attrs?: Record<string, string>;
  children: ReactNode;
}) {
  const r = useRouter();
  return (
    <tr
      {...attrs}
      data-row-href={href}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a, button, input, textarea, select, summary, label')) return;
        if (window.getSelection()?.toString()) return;
        if (e.metaKey || e.ctrlKey) { window.open(href, '_blank'); return; }
        r.push(href);
      }}
      className={`row-open group cursor-pointer ${selected ? 'bg-accentsoft' : ''} ${className}`}
    >
      {children}
    </tr>
  );
}

/**
 * The sign that a row opens something. Drawn on every row at every width — a phone has no hover,
 * so a hover-only cue tells a recruiter on one nothing. It sits beside the company name, in the
 * first column, which is the part of a sideways-scrolling table that is always on screen.
 */
export const OpenChevron = () => (
  <span data-row-open aria-hidden className="inline-grid place-items-center w-5 h-5 shrink-0 rounded-full border border-line text-ink3 text-[14px] leading-none group-hover:border-accent group-hover:text-accent">›</span>
);
