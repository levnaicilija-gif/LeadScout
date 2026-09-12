'use client';
import { useState } from 'react';

/**
 * A word a new recruiter does not know yet, explained where they meet it.
 *
 * A CV saying "6G, 141, Sa 2.5" is unreadable on day one, and looking each one up somewhere else
 * means not looking them up. So the terms are marked in place: hover for the one-line version,
 * click to keep it open and read the rest.
 *
 * The glossary is loaded once per screen and passed down — one query, not one per word.
 */
export type GlossaryTerm = { term: string; short: string; long?: string | null; category?: string | null; see_also?: string[] | null };

export function Term({ t, children }: { t: GlossaryTerm; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <button
        onClick={() => setOpen(!open)}
        title={t.short}
        className="border-b border-dotted border-ink3 cursor-help"
        aria-expanded={open}
      >
        {children ?? t.term}
      </button>
      {open && (
        <span className="absolute left-0 top-full z-20 mt-1 block w-[320px] bg-panel border border-line rounded shadow-[0_12px_32px_rgba(14,26,43,.16)] p-3 text-[13px] font-normal text-left">
          <b className="block font-semibold">{t.term}</b>
          {t.category && <span className="text-ink3 text-[11px] uppercase tracking-wide">{t.category}</span>}
          <span className="block mt-1">{t.short}</span>
          {t.long && <span className="block mt-1.5 text-ink2">{t.long}</span>}
          {!!t.see_also?.length && <span className="block mt-1.5 text-ink3 text-[12px]">See also: {t.see_also.join(', ')}</span>}
          <button className="block mt-2 text-accent text-[12px]" onClick={() => setOpen(false)}>Close</button>
        </span>
      )}
    </span>
  );
}

/**
 * Mark every glossary term found in a piece of text.
 *
 * Longest first, so "GWO BST" wins over "GWO", and each term is marked once per block — a
 * paragraph with "welder" six times does not need six dotted underlines. Matching is
 * whole-word and case-insensitive except for short all-caps codes like PA, PC and UT, which
 * would otherwise light up inside ordinary words.
 */
export function Glossed({ text, terms }: { text: string; terms: GlossaryTerm[] }) {
  if (!text || !terms.length) return <>{text}</>;

  const byTerm = new Map(terms.map((t) => [t.term.toLowerCase(), t]));
  const sorted = [...terms].sort((a, b) => b.term.length - a.term.length);
  const used = new Set<string>();
  const parts: (string | GlossaryTerm)[] = [text];

  for (const t of sorted) {
    const shortCode = t.term.length <= 3 && t.term === t.term.toUpperCase();
    const esc = t.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${esc}\\b`, shortCode ? '' : 'i');

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (typeof part !== 'string') continue;
      if (used.has(t.term.toLowerCase())) break;
      const m = part.match(re);
      if (!m || m.index === undefined) continue;
      used.add(t.term.toLowerCase());
      parts.splice(i, 1, part.slice(0, m.index), t, part.slice(m.index + m[0].length));
      break;
    }
  }

  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string'
          ? p
          : <Term key={`${p.term}-${i}`} t={byTerm.get(p.term.toLowerCase()) ?? p} />)}
    </>
  );
}
