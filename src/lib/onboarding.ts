/**
 * What a new recruiter may do, day by day.
 *
 * The order is not arbitrary. Verify and Candidates first, because reading documents is how you
 * learn what a trade is before you speak to anyone about it. Screening next, because a phone
 * call with a candidate costs nobody anything if it goes badly. Outreach after that, drafted but
 * reviewed, because a bad first email to a client cannot be taken back. Sends after that, and
 * Radar last, because deciding which leads are worth pursuing is the judgement that takes
 * longest to build.
 *
 * A senior is never gated. Nothing here hides data: a screen that is not yet unlocked says what
 * it is for and which day it opens, so the plan is visible rather than mysterious.
 */
export type Screen = 'home' | 'today' | 'verify' | 'candidates' | 'campaigns' | 'pitch' | 'radar' | 'settings';

export type DayPlan = {
  day: number;
  goal: string;
  unlocks: Screen[];
  /** Sends and outreach a senior must sign off before they leave the building. */
  reviewRequired: boolean;
};

const ALWAYS: Screen[] = ['home', 'today'];

export const PLAN: DayPlan[] = [
  { day: 1, goal: 'Read documents. Drop every CV and certificate you can find into Verify and see what comes back.', unlocks: [...ALWAYS, 'verify', 'candidates'], reviewRequired: true },
  { day: 2, goal: 'Learn the trades. Open a trade card for each trade in the pool and read what the certificates actually mean.', unlocks: [...ALWAYS, 'verify', 'candidates'], reviewRequired: true },
  { day: 3, goal: 'Screen someone. Use the questions on a candidate card and write down what they answered.', unlocks: [...ALWAYS, 'verify', 'candidates', 'campaigns'], reviewRequired: true },
  { day: 4, goal: 'Draft outreach. Write to a decision-maker on a lead — a senior reads it before it goes.', unlocks: [...ALWAYS, 'verify', 'candidates', 'campaigns', 'pitch'], reviewRequired: true },
  { day: 5, goal: 'Draft again, better. Look at what the senior changed yesterday and write two more.', unlocks: [...ALWAYS, 'verify', 'candidates', 'campaigns', 'pitch'], reviewRequired: true },
  { day: 6, goal: 'Send a pack. Put a candidate in front of a client — reviewed before it leaves.', unlocks: [...ALWAYS, 'verify', 'candidates', 'campaigns', 'pitch'], reviewRequired: true },
  { day: 7, goal: 'Send on your own judgement, still reviewed. Choose who to put forward and say why.', unlocks: [...ALWAYS, 'verify', 'candidates', 'campaigns', 'pitch'], reviewRequired: true },
  { day: 8, goal: 'Read the leads. Radar is open — decide which three are worth a call and which are not.', unlocks: [...ALWAYS, 'verify', 'candidates', 'campaigns', 'pitch', 'radar'], reviewRequired: false },
  { day: 9, goal: 'Work a lead end to end: job description, score the pool, questions, draft, send.', unlocks: [...ALWAYS, 'verify', 'candidates', 'campaigns', 'pitch', 'radar'], reviewRequired: false },
  { day: 10, goal: 'Your own desk. Everything is open; the reviews stop unless you ask for one.', unlocks: [...ALWAYS, 'verify', 'candidates', 'campaigns', 'pitch', 'radar'], reviewRequired: false },
];

const FULL: Screen[] = ['home', 'today', 'verify', 'candidates', 'campaigns', 'pitch', 'radar'];

export const planFor = (day?: number | null): DayPlan =>
  PLAN.find((p) => p.day === day) ?? { day: day ?? 99, goal: 'Your own desk.', unlocks: FULL, reviewRequired: false };

/** A senior is never gated; after day 10 nobody is. */
export function canSee(screen: Screen, user?: { role?: string | null; onboarding_day?: number | null } | null): boolean {
  if (!user) return false;
  if (user.role === 'senior') return true;
  if (screen === 'settings') return false;
  const day = user.onboarding_day ?? 99;
  if (day > 10) return true;
  return planFor(day).unlocks.includes(screen);
}

/** Does this person's outreach and sends need a senior's eyes? */
export const needsReview = (user?: { role?: string | null; onboarding_day?: number | null } | null) =>
  !!user && user.role !== 'senior' && planFor(user.onboarding_day ?? 99).reviewRequired;

/** The day a screen opens, for the message shown when it has not yet. */
export const opensOn = (screen: Screen): number =>
  PLAN.find((p) => p.unlocks.includes(screen))?.day ?? 10;
