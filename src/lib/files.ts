/**
 * Turning an uploaded file into something a model can read.
 *
 * DOCX is the case that used to fail silently: it was handed to the vision/document API as
 * `application/vnd.openxmlformats-...`, which is not a media type the API accepts, so the call
 * errored and the whole request died. mammoth converts it to text server-side instead.
 */
export type Prepared =
  | { kind: 'document'; base64: string; mediaType: 'application/pdf'; text?: undefined }
  | { kind: 'image'; base64: string; mediaType: string; text?: undefined }
  | { kind: 'text'; base64: string; mediaType: 'text/plain'; text: string }
  | { kind: 'unsupported'; base64: string; mediaType: string; text?: undefined };

const IMAGE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const extOf = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();

/** DOCX -> plain text, without pulling a headless Word into the bundle. */
export async function docxToText(bytes: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: bytes });
  return value.replace(/\n{3,}/g, '\n\n').trim();
}

export async function fileToBase64(bytes: Buffer, declaredType: string, filename: string): Promise<Prepared> {
  const ext = extOf(filename);
  const type = (declaredType || '').toLowerCase();

  if (type === 'application/pdf' || ext === 'pdf') {
    return { kind: 'document', base64: bytes.toString('base64'), mediaType: 'application/pdf' };
  }
  if (IMAGE.includes(type) || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    const mediaType = IMAGE.includes(type) ? type : ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { kind: 'image', base64: bytes.toString('base64'), mediaType };
  }
  if (ext === 'docx' || type.includes('officedocument.wordprocessingml')) {
    const text = await docxToText(bytes);
    return { kind: 'text', base64: Buffer.from(text, 'utf8').toString('base64'), mediaType: 'text/plain', text };
  }
  if (type.startsWith('text/') || ['txt', 'md', 'csv'].includes(ext)) {
    const text = bytes.toString('utf8');
    return { kind: 'text', base64: Buffer.from(text, 'utf8').toString('base64'), mediaType: 'text/plain', text };
  }
  return { kind: 'unsupported', base64: '', mediaType: type || 'application/octet-stream' };
}
