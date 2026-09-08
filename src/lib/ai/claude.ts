import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
export const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
export const MODEL_EXTRACT = 'claude-sonnet-4-6';
export const MODEL_CLASSIFY = 'claude-haiku-4-5';

/** Ask for JSON only; parse; validate with zod. Throws on failure — callers decide fallback. */
export async function askJson<S extends z.ZodTypeAny>(schema: S, system: string, user: string, model = MODEL_EXTRACT, maxTokens = 2000): Promise<z.output<S>> {
  const r = await claude.messages.create({ model, max_tokens: maxTokens, system: system + '\nReturn valid JSON only. No prose, no markdown fences.', messages: [{ role: 'user', content: user }] });
  const text = r.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  return schema.parse(JSON.parse(m ? m[0] : text));
}

/** THE honesty check: every string in `values` must appear (case-insensitive, whitespace-normalised) in `source`. */
export function appearsIn(source: string, ...values: (string | undefined)[]) {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const src = norm(source);
  return values.every((v) => !v || src.includes(norm(v)));
}
