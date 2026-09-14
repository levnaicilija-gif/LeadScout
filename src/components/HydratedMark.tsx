'use client';
import { useEffect } from 'react';

/**
 * Marks the page interactive: `<html data-hydrated="true">` once React has hydrated it.
 *
 * For checks, not for people. A server-rendered row or "?" button is on the page before its click handler
 * is, and a tap in that gap does nothing. On 2026-09-14 production smoke failed Leads at 390px on a touch
 * screen twice that way — the help stayed shut and the row tap went nowhere — while the screen itself worked.
 * Scripts wait for this attribute before they tap, never for a fixed time.
 */
export function HydratedMark() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = 'true';
  }, []);
  return null;
}
