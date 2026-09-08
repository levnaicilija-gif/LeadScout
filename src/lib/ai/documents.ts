import { z } from 'zod';
import { askJson, claude, MODEL_EXTRACT } from './claude';

export const CertSchema = z.object({
  doc_type: z.enum(['certificate', 'passport', 'cv', 'medical', 'a1', 'test_report', 'other']),
  cert_body: z.string().optional(), // frosio|pcn|cswip|ampp|irata|winda|cisrs|iso9606|electrical_dk|other
  issuer: z.string().optional(), number: z.string().optional(), holder: z.string().optional(),
  level: z.string().optional(), process: z.string().optional(), position: z.string().optional(),
  method: z.string().optional(), scope: z.string().optional(),
  /** yyyy-mm-dd. Printed on passports and on some certificates; CSWIP verifies on it. */
  dob: z.string().optional(),
  /** Verification URL or QR-code target printed on the certificate — the only way to check a FROSIO/Accredible credential. */
  credential_url: z.string().optional(),
  issued: z.string().optional(), expiry: z.string().optional(), unreadable: z.array(z.string()).default([]),
});
export type CertExtraction = z.output<typeof CertSchema>;

/** Vision extraction: image/PDF as base64. */
export async function extractDocument(base64: string, mediaType: string): Promise<CertExtraction> {
  const r = await claude.messages.create({
    model: MODEL_EXTRACT, max_tokens: 800,
    system: 'Read this document for a recruitment agency. Classify it and copy the fields exactly as printed. If a field is unreadable, list it in unreadable. cert_body: frosio, pcn, cswip, ampp, irata, winda, cisrs, iso9606 (any welder qualification), electrical_dk, or other. number: the registry/certificate number as printed (for PCN copy the PCN number as well if both are shown). method: the NDT/inspection method or discipline. scope: the scope line. credential_url: any verification URL printed on the certificate or encoded in a QR code (e.g. credential.net/...), copied exactly; omit if none. dob: date of birth as yyyy-mm-dd if printed (passports always print it). Return JSON only.',
    messages: [{ role: 'user', content: [{ type: mediaType === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: mediaType as any, data: base64 } } as any, { type: 'text', text: 'Extract.' }] }],
  });
  const text = r.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');
  return CertSchema.parse(JSON.parse(text.match(/\{[\s\S]*\}/)![0]));
}

export const ProfileSchema = z.object({
  full_name: z.string().optional(), trade: z.string(), trade_code: z.enum(['P', 'W', 'F', 'N', 'R', 'E', 'O']).default('O'),
  certificates_claimed: z.array(z.string()).default([]),
  projects: z.array(z.object({ years: z.string(), type: z.string(), country: z.string(), employer: z.string().optional(), rotation: z.string().optional() })).default([]),
  skills: z.array(z.string()).default([]), languages: z.array(z.string()).default([]), availability: z.string().optional(),
  pii: z.object({ phone: z.string().optional(), email: z.string().optional(), address: z.string().optional(), dob: z.string().optional() }).default({}),
});
export type Profile = z.output<typeof ProfileSchema>;
export const parseCv = (cvText: string) => askJson(ProfileSchema, 'Parse this CV (any language) into a structured profile in English for an industrial/offshore staffing agency. Copy facts; do not embellish. trade_code: P painter/blaster, W welder, F fitter/pipefitter, N NDT, R rope access, E electrician/wind tech, O other.', cvText.slice(0, 30000));

export const anonymize = (p: Profile) => ({
  trade: p.trade, certificates: p.certificates_claimed,
  projects: p.projects.map(({ years, type, country, rotation }) => ({ years, type, country, rotation })), // employer dropped
  skills: p.skills, languages: p.languages, availability: p.availability,
});

/** PII check on the client-facing text. Regex first, then a model review. */
export function piiRegexHits(text: string, fullName?: string, employers: string[] = []) {
  const hits: string[] = [];
  if (/\+?\d[\d\s().-]{7,}\d/.test(text)) hits.push('phone-like number');
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(text)) hits.push('email');
  if (fullName && fullName.split(/\s+/).some((n) => n.length > 2 && new RegExp(`\\b${n}\\b`, 'i').test(text))) hits.push('name');
  for (const e of employers) if (e && e.length > 3 && text.toLowerCase().includes(e.toLowerCase())) hits.push(`employer: ${e}`);
  return hits;
}

export const BulletsSchema = z.object({ bullets: z.array(z.string()).length(3) });
export const clientBullets = (anon: object, verified: object[], jobContext?: string) =>
  askJson(BulletsSchema, 'Write exactly three bullets that best sell this anonymized candidate to a client. Each bullet must cite a verifiable fact from the data (certificate + check date, project type + year, availability/rotation). No name. No employer names. Max 28 words each.', JSON.stringify({ candidate: anon, verified_certificates: verified, job: jobContext ?? null }));

export const ScoreSchema = z.object({ score: z.number().min(0).max(100), fits: z.array(z.string()), missing: z.array(z.string()), blockers: z.array(z.string()) });
export const scoreAgainstJob = (anon: object, verified: object[], jd: string) =>
  askJson(ScoreSchema, 'Score how well this candidate matches the job (0–100). fits: evidence from the CV. missing: what is absent and what would close it (e.g. "ICATS card — FROSIO accepted by most UK yards, confirm"). blockers: hard requirements not met (passport, required cert level, language). Be strict and specific.', JSON.stringify({ candidate: anon, verified_certificates: verified, job: jd }));

export const JdSchema = z.object({ job_description: z.string(), assumptions: z.array(z.string()) });
export const jdFromLead = (lead: object, articleText: string) =>
  askJson(JdSchema, 'Write a working job description for a trades staffing agency from this lead. Use only stated facts; where you must assume (typical certs for this company type, rotation), list each assumption separately so the recruiter can confirm on the call.', JSON.stringify({ lead, source_text: articleText.slice(0, 8000) }));

export const QuestionsSchema = z.object({ questions: z.array(z.object({ q: z.string(), good_answer: z.string() })).min(6).max(8) });
export const screeningQuestions = (jd: string) =>
  askJson(QuestionsSchema, 'Write 6–8 screening questions a recruiter asks a candidate for this role: technical (process/positions/standards), certificates and expiry, rotation history, offshore medical/safety training, passport/A1, English on site, rate and start, conflicts. For each, what a good answer sounds like.', jd);

export const OutreachSchema = z.object({ subject: z.string(), email: z.string(), linkedin: z.string().max(300), reasoning: z.string() });
export const draftOutreach = (ctx: object) =>
  askJson(OutreachSchema, 'Draft an outreach email and a LinkedIn connection message (<300 chars) from a staffing agency to this decision-maker. Open with their own quote or the posting. State proof: verified certs, availability dates, prior relevant projects, contract model. Ask for one small step. Short. reasoning: one line on why it is written this way.', JSON.stringify(ctx));
