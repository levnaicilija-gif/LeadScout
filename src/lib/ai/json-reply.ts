/**
 * The JSON object inside a model's reply, or an error that says plainly why there is none.
 *
 * Replies arrive wrapped in prose, inside markdown fences, or as a one-element array — and sometimes
 * with no JSON in them at all. extractDocument used to take `text.match(/\{[\s\S]*\}/)![0]`, which on
 * such a reply threw "Cannot read properties of null (reading '0')": on 2026-09-14 the release gate's
 * CV came back "unreadable" that way, and Verify told the recruiter a .docx was the wrong file type.
 *
 * Shared by askJson and extractDocument, so there is one way to read a reply, not two.
 */
export function jsonFromReply(text: string): unknown {
  const reply = text ?? '';
  const m = reply.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) {
    const said = reply.trim();
    throw new Error(`the reply held no JSON${said ? ` (it began: "${said.slice(0, 80)}")` : ' (it was empty)'}`);
  }
  let parsed: unknown = JSON.parse(m[0]);
  // The model sometimes wraps the object in an array — a real CV failed with "Expected object,
  // received array". Every schema here describes one object, so unwrap it rather than lose the reading.
  if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) parsed = parsed[0];
  return parsed;
}
