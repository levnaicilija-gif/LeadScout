/**
 * The model-calling tools a recruiter starts by pressing something, by the name each one logs to cost_log's `kind`.
 *
 * Item 16 (owner's decision, recorded under item 16 in the queue): a recruiter's tool is recorded against their workspace
 * and counted in the day's spend, and is never stopped by the daily cap — a person is not blocked mid-task. Automated
 * jobs hard-stop at the cap. Every other `kind` in cost_log is an automated job's.
 *
 * No imports, so cost.ts (Home's split) and meter.ts can both read it.
 */
export const RECRUITER_TOOLS = {
  'document-read': 'Read a dropped document (Verify)',
  'cv-transcribe': 'Transcribe a PDF or image CV',
  'cv-parse': 'CV parsing',
  'bullets': 'Client bullets',
  'bullets-audit': 'Bullet audit against the profile',
  'client-summary': 'Client summary',
  'pii-review': 'PII model review',
  'candidate-score': 'Candidate scoring',
  'job-description': 'Job description',
  'screening-questions': 'Screening questions for a job',
  'candidate-questions': 'Screening questions for a candidate',
  'outreach-draft': 'Outreach draft',
  'outreach-audit': 'Outreach draft audit against the pool',
} as const;

export type RecruiterTool = keyof typeof RECRUITER_TOOLS;

export const isRecruiterTool = (kind: string): kind is RecruiterTool => Object.prototype.hasOwnProperty.call(RECRUITER_TOOLS, kind);

/** A call that reached the model with no tool named and no signed-in request around it: a script, or a gap in the metering. */
export const UNATTRIBUTED = 'unattributed';
