/**
 * Reading JSON out of a model's reply, and what Verify tells a recruiter when that fails. No network.
 *
 *   npx tsx scripts/json-reply-check.ts
 *
 * The release gate cannot make the model answer without JSON on demand, so these are the replies that
 * broke things, fed in directly. On 2026-09-14 a reply with no JSON reached `text.match(...)![0]` in
 * extractDocument, threw "Cannot read properties of null (reading '0')", marked a good CV unreadable,
 * and friendlyError then blamed the file type. Exits 1 on any failure.
 */
import { jsonFromReply } from '../src/lib/ai/json-reply';
import { friendlyError } from '../src/lib/friendly-error';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const thrown = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e: any) { return String(e?.message ?? e); }
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Replies that carry an object.
check(same(jsonFromReply('{"doc_type":"cv","unreadable":[]}'), { doc_type: 'cv', unreadable: [] }), 'a bare object');
check(same(jsonFromReply('Here are the fields:\n```json\n{"doc_type":"certificate"}\n```'), { doc_type: 'certificate' }), 'an object inside prose and a markdown fence');
check(same(jsonFromReply('[{"doc_type":"contract"}]'), { doc_type: 'contract' }), 'an object wrapped in a one-element array is unwrapped');

// Replies that do not — each must say what happened, never "Cannot read properties of null".
const prose = thrown(() => jsonFromReply('I am unable to extract fields from this document.'));
check(!!prose && /held no JSON/.test(prose) && /began: "I am unable/.test(prose) && !/reading '0'/.test(prose),
  'a reply with no JSON throws a message saying so, quoting how it began', prose ?? 'did not throw');
const empty = thrown(() => jsonFromReply(''));
check(!!empty && /held no JSON \(it was empty\)/.test(empty), 'an empty reply says it was empty', empty ?? 'did not throw');
const cut = thrown(() => jsonFromReply('{"doc_type": "cv", "holder": "Mar'));
check(!!cut && !/reading '0'/.test(cut), 'JSON cut off part-way throws a readable error, not a null access', cut ?? 'did not throw');
const broken = thrown(() => jsonFromReply('{"doc_type": cv}'));
check(!!broken && !/reading '0'/.test(broken), 'malformed JSON throws the parse error, not a null access', broken ?? 'did not throw');

// What the recruiter is told.
const crash = friendlyError("Cannot read properties of null (reading '0')", 'cv');
check(!/file type/i.test(crash) && /on our side/.test(crash), 'a crash in our own code is not blamed on the file type', crash);
check(/file type can't be read/.test(friendlyError('unsupported file type — use PDF, DOCX or a photo', 'cv')), 'an unsupported file still says the file type cannot be read');
const twice = friendlyError('the document could not be read into fields after two attempts: the reply held no JSON (it was empty)', 'cv');
check(/Couldn't read this CV/.test(twice) && !/file type/i.test(twice), 'two failed readings ask for another try, without blaming the file type', twice);

console.log(failures === 0 ? '\njson reply: all checks passed' : `\njson reply: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
