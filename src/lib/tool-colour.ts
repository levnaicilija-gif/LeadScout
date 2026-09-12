/**
 * The per-tool colours from design/leadscout-design-v4.html, as whole class names.
 *
 * Tailwind reads the source at build time, so a class assembled at runtime — `bg-tool-${tool}` —
 * is never generated and silently renders as nothing. Every tool colour therefore goes through
 * one of these maps, where the full string appears literally.
 */
export type Tool = 'today' | 'leads' | 'verify' | 'pitch' | 'cand' | 'set';

/** The 6px stripe across the top of a card. */
export const STRIPE: Record<Tool, string> = {
  today: 'bg-tool-radar', leads: 'bg-tool-leads', verify: 'bg-tool-verify',
  pitch: 'bg-tool-pitch', cand: 'bg-tool-cand', set: 'bg-tool-set',
};

/** The rounded icon tile. */
export const TILE: Record<Tool, string> = {
  today: 'bg-white/10 text-white', leads: 'bg-soft-leads text-tool-leads', verify: 'bg-soft-verify text-tool-verify',
  pitch: 'bg-soft-pitch text-tool-pitch', cand: 'bg-soft-cand text-tool-cand', set: 'bg-soft-set text-tool-set',
};

/** The pill in the top-right corner, when it carries no status of its own. */
export const PILL: Record<Tool, string> = {
  today: 'bg-white/12 text-white', leads: 'bg-soft-leads text-tool-leads', verify: 'bg-soft-verify text-tool-verify',
  pitch: 'bg-soft-pitch text-tool-pitch', cand: 'bg-soft-cand text-tool-cand', set: 'bg-soft-set text-tool-set',
};

/** The action button at the foot of a card. Today's inverts, as the tile itself is dark. */
export const ACTION: Record<Tool, string> = {
  today: 'bg-white text-rail', leads: 'bg-tool-leads text-white', verify: 'bg-tool-verify text-white',
  pitch: 'bg-tool-pitch text-white', cand: 'bg-tool-cand text-white', set: 'bg-tool-set text-white',
};

/** The dot beside a nav item. */
export const DOT: Record<Tool, string> = {
  today: 'bg-tool-radar', leads: 'bg-tool-leads', verify: 'bg-tool-verify',
  pitch: 'bg-tool-pitch', cand: 'bg-tool-cand', set: 'bg-tool-set',
};
