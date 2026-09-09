import { z } from 'zod';
import { askJson, appearsIn } from './claude';

/**
 * A model asked for an optional field returns `null` about as often as it omits it, and zod's
 * .optional() rejects null — which threw mid-article and, because the throw was only caught at
 * source level, discarded every remaining article for that source. Accept both.
 */
const str = () => z.string().nullish().transform((v) => v ?? undefined);
const arr = <T extends z.ZodTypeAny>(item: T) => z.array(item).nullish().transform((v) => v ?? []);

/**
 * Rows of a list arrive with the odd key renamed ("company" for "name") or a field missing.
 * Drop the unusable row instead of throwing away the whole extraction — losing one of the
 * companies also mentioned in an article is not a reason to lose the lead.
 */
const rows = <T extends z.ZodTypeAny>(item: T, required: string[], alias: Record<string, string[]> = {}) =>
  z.preprocess((v) => {
    if (!Array.isArray(v)) return [];
    return v
      .map((raw: any) => {
        if (!raw || typeof raw !== 'object') return null;
        const o = { ...raw };
        for (const [key, from] of Object.entries(alias)) if (o[key] == null) for (const f of from) if (o[f] != null) { o[key] = o[f]; break; }
        return o;
      })
      .filter((o: any) => o && required.every((k) => typeof o[k] === 'string' && o[k].trim()));
  }, z.array(item)).default([]);

const Schema = z.object({
  qualifies: z.boolean(),
  company: str(),
  people: rows(z.object({ name: z.string(), title: z.string(), quote: z.string() }), ['name', 'title', 'quote'], { name: ['person', 'full_name'], title: ['job_title', 'role'] }),
  project: z.object({ name: str(), location: str(), value: str(), phase: str(), start: str(), end: str() }).nullish().transform((v) => v ?? undefined),
  trades: arr(z.string()),
  companies_mentioned: rows(
    z.object({ name: z.string(), role: z.string().nullish().transform((v) => v ?? ''), start: str() }),
    ['name'],
    { name: ['company', 'company_name'] },
  ),
  reason: str(),
});
export type RadarExtraction = z.output<typeof Schema>;

const SYSTEM = `You extract recruitment leads from industry news for an industrial/offshore staffing agency.

STAGE 1 RULES — qualifies=true only if ALL are true:
1) the article is about a company WINNING or being AWARDED a contract or project;
2) a person FROM THAT COMPANY is quoted by name with a job title;
3) that person is realistically contactable (not a journalist, analyst, government official, or someone from another company).
If any is false, return {"qualifies":false,"reason":"which rule failed and why"} and nothing else.

When qualifies=true you MUST fill these fields — a lead without them is useless:
- company: the single company that WON the work, exactly as the article spells it. This is
  required. If you cannot name that company, then rule 1 is not satisfied: return
  qualifies=false with the reason instead.
- people: every person FROM THAT COMPANY quoted by name, each with name, title and the quote.
  At least one is required, or rule 2 is not satisfied.
- project: name, location, value, phase and dates, where the article states them.
- trades: which manual trades the work implies (welder, painter, blaster, pipefitter, ndt,
  rope access, wind technician, electrician, scaffolder) — infer from the scope of work, not
  from the article's wording. Return [] if the scope does not imply manual trades.
- companies_mentioned: every other company named, with its role in the project and expected
  start of activity (verbatim dates only).

Names, titles, quotes, values and dates must be copied VERBATIM from the article text.
Never guess an email or phone.`;

/**
 * Extract and then VALIDATE against the source text. Anything not in the article is dropped.
 * Returns why it rejected, so the daily run can be reviewed without re-running extraction.
 */
export type LeadResult = { ok: true; lead: RadarExtraction } | { ok: false; why: string };

export async function extractLead(articleText: string, url: string): Promise<LeadResult> {
  const out = await askJson(Schema, SYSTEM, `URL: ${url}\n\nARTICLE:\n${articleText.slice(0, 20000)}`);
  if (!out.qualifies) return { ok: false, why: out.reason?.trim() || 'does not meet Stage 1 rules' };
  if (!out.company) return { ok: false, why: 'qualified but named no company' };
  if (!appearsIn(articleText, out.company)) return { ok: false, why: `company "${out.company}" is not in the article text` };

  const before = out.people.length;
  out.people = out.people.filter((p) => appearsIn(articleText, p.name, p.title) && appearsIn(articleText, p.quote.slice(0, 60)));
  if (out.people.length === 0) {
    return { ok: false, why: before === 0 ? 'no person from the company is quoted by name with a title' : `all ${before} quoted people failed the verbatim check against the article` };
  }
  out.companies_mentioned = out.companies_mentioned.filter((c) => appearsIn(articleText, c.name));
  return { ok: true, lead: out };
}

const JobSchema = z.object({
  is_job_post: z.boolean(), company: str(), role: str(), trades: arr(z.string()),
  location: str(), country: str(), posted_at: str(), start: str(),
  rotation: str(), contract_type: str(), headcount: z.number().nullish().transform((v) => v ?? undefined), certs_required: arr(z.string()),
  contact: z.object({ name: str(), title: str(), email: str(), phone: str() }).nullish().transform((v) => v ?? undefined),
});
export type JobExtraction = z.output<typeof JobSchema>;
export async function extractJobPost(pageText: string, url: string): Promise<JobExtraction | null> {
  const out = await askJson(JobSchema, `You read a job posting page for a trades staffing agency. Copy company, role, location, dates, certs and any printed contact VERBATIM. If a field is not printed on the page, omit it. Never invent an email or phone.`, `URL: ${url}\n\nPAGE:\n${pageText.slice(0, 15000)}`);
  if (!out.is_job_post || !out.company) return null;
  if (out.contact) {
    if (!appearsIn(pageText, out.contact.name, out.contact.email, out.contact.phone)) out.contact = undefined;
  }
  return out;
}
