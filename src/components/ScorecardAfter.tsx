'use client';
import { useEffect, useState } from 'react';
import { Scorecard } from './Scorecard';

/**
 * The day's scorecard, from a given hour onwards.
 *
 * The hour is read in the browser on purpose. Today renders on the server, and the server's clock
 * is not the recruiter's — a recruiter an hour or two away would otherwise see their day's card
 * early or late by exactly that difference. Rendering nothing until the browser says so also keeps
 * the server's HTML the same for everyone, so there is no hydration mismatch to paper over.
 */
export function ScorecardAfter({ hour }: { hour: number }) {
  const [show, setShow] = useState(false);
  useEffect(() => { setShow(new Date().getHours() >= hour); }, [hour]);
  if (!show) return null;
  return <Scorecard />;
}
