import crypto from 'node:crypto';

/**
 * Where an uploaded document is stored, with no name in the path.
 *
 * Every upload site used to build its own path from the file the recruiter dropped, so a CV
 * called "Bertescu_Dumitrel_CV_Final_Readable.pdf" put the candidate's name into object storage
 * and into documents.storage_path. That is internal and never served to a client — but a name
 * in a path is a name, it turns up in logs, backups, signed URLs and bucket listings, and none
 * of those are places anyone thinks to look for one.
 *
 * The path now carries the candidate id where there is one, a short digest of the original file
 * name where there is not, and nothing else. The digest is stable, so re-uploading the same file
 * lands on the same key and a duplicate does not silently become a second object; it is one-way,
 * so the name cannot be read back out of it.
 *
 * One helper, used by all three upload sites, because this is exactly the kind of rule that
 * drifts when each caller spells it out for itself.
 */

/** The extension, from the file name, lower-cased and bounded. Never the name itself. */
function extensionOf(filename: string, contentType?: string | null): string {
  const fromName = filename.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  const byType: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'text/plain': 'txt',
  };
  return byType[String(contentType ?? '').toLowerCase()] ?? 'bin';
}

/** Twelve hex characters is enough to separate files and far too few to reverse. */
const digest = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

export function documentPath(input: {
  workspaceId: string;
  /** 'cv', 'certificate', 'passport' … the document's own type, which identifies nobody. */
  type: string;
  filename: string;
  contentType?: string | null;
  /** Present once the document belongs to someone; absent while it is still unattached. */
  candidateId?: string | null;
}): string {
  const ext = extensionOf(input.filename, input.contentType);
  const who = input.candidateId ?? 'unattached';
  return `${input.workspaceId}/${input.type}/${who}/${digest(input.filename)}.${ext}`;
}

/** Does a stored path still carry something that could be a name? Used by the audit. */
export function pathLooksNamed(path: string): boolean {
  const leaf = path.split('/').pop() ?? '';
  // What the helper produces: twelve hex characters and an extension, nothing else.
  return !/^[0-9a-f]{12}\.[a-z0-9]{1,8}$/.test(leaf);
}
