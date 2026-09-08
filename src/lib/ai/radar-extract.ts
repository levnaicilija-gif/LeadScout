import { z } from 'zod';
import { askJson, appearsIn } from './claude';

const Schema = z.object({
  qualifies: z.boolean(),
  company: z.string().optional(),
  people: z.array(z.object({ name: z.string(), title: z.string(), quote: z.string() })).default([]),
  project: z.object({ name: z.string().optional(), location: z.string().optional(), value: z.string().optional(), phase: z.string().optional(), start: z.string().optional(), end: z.string().optional() }).optional(),
  trades: z.array(z.string()).default([]),
  companies_mentioned: z.array(z.object({ name: z.string(), role: z.string(), start: z.string().optional() })).default([]),
  reason: z.string().optional(),
});
export type RadarExtraction = z.output<typeof Schema>;

const SYSTEM = `You extract recruitment leads from industry news for an industrial/offshore staffing agency.
STAGE 1 RULES — qualifies=true only if ALL are true:
1) the article is about a company WINNING or being AWARDED a contract or project;
2) a person FROM THAT COMPANY is quoted by name with a job title;
3) that person is realistically contactable (not a journalist, analyst, government official, or someone from another company).
If it does not qualify, return {"qualifies":false,"reason":"..."}.
Names, titles and quotes must be copied VERBATIM from the article text. Never guess an email or phone.
Also map every company mentioned to its role in the project and expected start of activity (verbatim dates only).
trades: which manual trades the work implies (welder, painter, blaster, pipefitter, ndt, rope access, wind technician, electrician, scaffolder) — infer from the scope, not from the article's words.`;

/** Extract and then VALIDATE against the source text. Anything not in the article is dropped. */
export async function extractLead(articleText: string, url: string): Promise<RadarExtraction | null> {
  const out = await askJson(Schema, SYSTEM, `URL: ${url}\n\nARTICLE:\n${articleText.slice(0, 20000)}`);
  if (!out.qualifies || !out.company) return null;
  if (!appearsIn(articleText, out.company)) return null;
  out.people = out.people.filter((p) => appearsIn(articleText, p.name, p.title) && appearsIn(articleText, p.quote.slice(0, 60)));
  if (out.people.length === 0) return null; // rule 2
  out.companies_mentioned = out.companies_mentioned.filter((c) => appearsIn(articleText, c.name));
  return out;
}

const JobSchema = z.object({
  is_job_post: z.boolean(), company: z.string().optional(), role: z.string().optional(), trades: z.array(z.string()).default([]),
  location: z.string().optional(), country: z.string().optional(), posted_at: z.string().optional(), start: z.string().optional(),
  rotation: z.string().optional(), contract_type: z.string().optional(), headcount: z.number().optional(), certs_required: z.array(z.string()).default([]),
  contact: z.object({ name: z.string().optional(), title: z.string().optional(), email: z.string().optional(), phone: z.string().optional() }).optional(),
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
