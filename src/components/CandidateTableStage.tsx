'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { StageSelect } from './CandidateStage';
import type { Stage } from '@/lib/candidate-stages';

/** A table row's stage picker. The table is rendered on the server, so after a move it refreshes to show the new facts. */
export function CandidateTableStage({ candidate }: { candidate: { id: string; name: string | null; stage: Stage; placedAt: string | null } }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>(candidate.stage);
  return <StageSelect candidate={{ ...candidate, stage }} onMoved={(s) => { setStage(s); router.refresh(); }} />;
}
