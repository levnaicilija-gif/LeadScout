/**
 * The candidate pipeline's words (item 24, owner's stages 2026-09-15). No imports, so a client component can use them
 * without pulling the pool loader or the search into the browser.
 */
export const STAGES = ['new', 'screening', 'presented', 'placed', 'bench'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL: Record<Stage, string> = { new: 'New', screening: 'Screening', presented: 'Presented', placed: 'Placed', bench: 'Bench' };

export const PREFERENCES = ['permanent', 'contract', 'either'] as const;
export type Preference = (typeof PREFERENCES)[number];
export const PREFERENCE_LABEL: Record<Preference, string> = { permanent: 'Permanent', contract: 'Contract', either: 'Either' };
