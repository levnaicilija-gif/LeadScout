/**
 * A recruiter should never be shown a zod trace. Say what happened and what to do; keep the
 * technical text for the collapsed detail, because it is what makes a bug report useful.
 */
export function friendlyError(raw: string, what: 'cv' | 'certificate' = 'cv'): string {
  const t = (raw ?? '').toLowerCase();
  const thing = what === 'cv' ? 'CV' : 'certificate';

  if (t.includes('unsupported file type') || t.includes('cannot read')) return `That file type can't be read. Use a PDF, DOCX, JPG or PNG.`;
  if (t.includes('no readable text')) return `There was no readable text in this ${thing}. If it is a scan, a clearer photo or a PDF usually works.`;
  if (t.includes('expected object') || t.includes('expected string') || t.includes('invalid_type') || t.includes('unrecognized') || t.includes('json')) {
    return `Couldn't read this ${thing} — try again, or use a PDF version.`;
  }
  if (t.includes('took longer than') || t.includes('aborted') || t.includes('timeout')) return `This ${thing} took too long to read. Try again, or split a very long file.`;
  if (t.includes('row-level security') || t.includes('permission')) return `You don't have permission to save this here. Ask a senior recruiter to check the workspace.`;
  if (t.includes('could not store')) return `The file was read but could not be saved. Try again in a moment.`;
  if (t.includes('unauthorised') || t.includes('401')) return `Your session has expired. Sign in again.`;
  if (t.includes('rate') && t.includes('limit')) return `Too many requests at once. Wait a moment and try again.`;
  return `Something went wrong reading this ${thing}. Try again, or use a PDF version.`;
}
