'use client';
import { useSyncExternalStore } from 'react';

/**
 * One "add a CV" action behind every way in (item 24 follow-up, 2026-09-15): the drop zone at the foot of the rail, the
 * same zone on Home, the floating "+ Add CV" button at narrow widths, and a CV dropped anywhere on the page.
 *
 * CandidateDrop owns the reading and the result panel and registers here; the zones call it. A module-level store, because
 * the zones live in the rail and on Home while CandidateDrop lives in the /app layout, and none of them contains the others.
 */
export type CvDropState = { busy: boolean; dragging: boolean };
type Handlers = { run: (files: File[]) => void; browse: () => void };

const IDLE: CvDropState = { busy: false, dragging: false };
let state: CvDropState = IDLE;
let handlers: Handlers | null = null;
const listeners = new Set<() => void>();

export const cvDrop = {
  register(h: Handlers) {
    handlers = h;
    return () => { if (handlers === h) handlers = null; };
  },
  run: (files: File[]) => handlers?.run(files),
  browse: () => handlers?.browse(),
  set(next: Partial<CvDropState>) {
    if (Object.entries(next).every(([k, v]) => state[k as keyof CvDropState] === v)) return;
    state = { ...state, ...next };
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
};

export function useCvDrop(): CvDropState {
  return useSyncExternalStore(cvDrop.subscribe, () => state, () => IDLE);
}
