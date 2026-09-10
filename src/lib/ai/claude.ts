import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
export const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Sonnet 5: newer than 4-6 and cheaper with it ($2/$10 per Mtok against $3/$15).
export const MODEL_EXTRACT = 'claude-sonnet-5';
export const MODEL_CLASSIFY = 'claude-haiku-4-5';

/** Ask for JSON only; parse; validate with zod. Throws on failure — callers decide fallback. */
/**
 * The top-level keys a schema requires, so the prompt can name them.
 *
 * Every prompt that did not spell out its keys has eventually been answered under different
 * ones — doc_type as "document_type", bullets under some other name, a job description missing
 * "job_description" entirely — and each time the whole call was lost to a zod error. Taking the
 * keys from the schema means the instruction cannot drift away from what the parse demands.
 */
function keysOf(schema: z.ZodTypeAny): string[] {
  let s: any = schema;
  for (let i = 0; i < 6 && s; i++) {
    if (s instanceof z.ZodObject) return Object.keys(s.shape);
    // Unwrap preprocess/transform/optional/default wrappers to reach the object underneath.
    s = s._def?.schema ?? s._def?.innerType ?? s._def?.in ?? null;
  }
  return [];
}

export async function askJson<S extends z.ZodTypeAny>(schema: S, system: string, user: string, model = MODEL_EXTRACT, maxTokens = 2000): Promise<z.output<S>> {
  const keys = keysOf(schema);
  const shape = keys.length ? ` The object must use exactly these top-level keys: ${keys.map((k) => `"${k}"`).join(', ')}.` : '';
  const base = `${system}\nReturn valid JSON only. Return a single JSON object, not an array.${shape} No prose, no markdown fences.`;

  let lastProblem = '';
  // Two attempts. The first failure is described back to the model rather than thrown at the
  // recruiter: every one of these seen in practice — a key under another name, a field sent as
  // a string where a list was wanted, JSON cut off by the token ceiling — is fixed by saying
  // what went wrong and asking again, and losing a whole lead tool to it helps nobody.
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await claude.messages.create({
      model,
      // A truncated reply is a syntax error, not a shape error: give the retry more room.
      max_tokens: attempt === 0 ? maxTokens : Math.min(maxTokens * 2, 8000),
      system: attempt === 0 ? base : `${base}\n\nA previous attempt could not be used: ${lastProblem}\nReturn the whole object again, corrected. Keep every value complete — do not truncate.`,
      messages: [{ role: 'user', content: user }],
    });
    const text = r.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');

    try {
      const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      let parsed = JSON.parse(m ? m[0] : text);
      // The model sometimes wraps the object in an array — a real CV failed with
      // "Expected object, received array". Every schema here describes one object, so unwrap it
      // rather than losing the extraction to a bracket.
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) parsed = parsed[0];
      return schema.parse(parsed);
    } catch (e: any) {
      if (attempt === 1) throw e;
      lastProblem = e instanceof z.ZodError
        ? e.issues.map((i) => `${i.path.join('.') || '(root)'} — ${i.message}`).join('; ')
        : `the JSON did not parse (${String(e?.message ?? e).slice(0, 120)})`;
    }
  }
  throw new Error('unreachable');
}

/** THE honesty check: every string in `values` must appear (case-insensitive, whitespace-normalised) in `source`. */
export function appearsIn(source: string, ...values: (string | undefined)[]) {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const src = norm(source);
  return values.every((v) => !v || src.includes(norm(v)));
}
