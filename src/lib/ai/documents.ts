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

/** Extraction from a PDF, an image, or plain text (DOCX arrives here already converted). */
export async function extractDocument(base64: string, mediaType: string): Promise<CertExtraction> {
  const asText = mediaType === 'text/plain';
  const source = asText
    ? [{ type: 'text', text: Buffer.from(base64, 'base64').toString('utf8').slice(0, 30000) }]
    : [{ type: mediaType === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }];
  const r = await claude.messages.create({
    model: MODEL_EXTRACT, max_tokens: 800,
    // The key names are not negotiable. Asked in prose, the model returns sensible names of
    // its own ("document_type", "certificate_number", "issuing_body") and every parse fails,
    // which is exactly how Verify came to reject every document it was ever given.
    system: `Read this document for a recruitment agency and copy the fields exactly as printed.

Return ONLY this JSON object, using these exact keys and no others:
{
  "doc_type": "certificate | passport | cv | medical | a1 | test_report | other",
  "cert_body": "frosio | pcn | cswip | ampp | irata | winda | cisrs | iso9606 | electrical_dk | other",
  "issuer": "the organisation that issued it, as printed",
  "number": "the certificate or registry number as printed; for PCN prefer the PCN number when both are shown",
  "holder": "the person's full name as printed",
  "level": "certification level",
  "process": "welding process",
  "position": "welding position",
  "method": "the NDT or inspection method / discipline",
  "scope": "the scope line",
  "dob": "date of birth as yyyy-mm-dd, if printed",
  "credential_url": "any verification URL printed or encoded in a QR code, copied exactly",
  "issued": "date of issue as printed",
  "expiry": "expiry date as printed",
  "unreadable": ["names of fields you could not read"]
}

doc_type and unreadable are required. Omit any other key whose value is not on the document — never guess one. Return the JSON only, with no prose and no markdown fences.`,
    messages: [{ role: 'user', content: [...(source as any[]), { type: 'text', text: 'Extract.' }] as any }],
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
export const parseCv = (cvText: string) => askJson(ProfileSchema, `Parse this CV (any language) into a structured profile in English for an industrial/offshore staffing agency. Copy facts; do not embellish.

Return ONLY this JSON object, using these exact keys and no others:
{
  "full_name": "the candidate's name as printed",
  "trade": "their trade in English, e.g. Industrial painter / blaster",
  "trade_code": "P painter/blaster | W welder | F fitter/pipefitter | N NDT | R rope access | E electrician/wind tech | O other",
  "certificates_claimed": ["each certificate named on the CV, as printed"],
  "projects": [{ "years": "2025-26", "type": "what the work was", "country": "country", "employer": "employer name", "rotation": "e.g. 8:2" }],
  "skills": ["skill"],
  "languages": ["language (level)"],
  "availability": "when they are free, as stated",
  "pii": { "phone": "", "email": "", "address": "", "dob": "yyyy-mm-dd" }
}

trade and trade_code are required. Omit any other key the CV does not state. Return the JSON only, with no prose and no markdown fences.`, cvText.slice(0, 30000));

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

/**
 * Second PII pass, after piiRegexHits. The regex catches shapes (a phone, an email, a known
 * name); this catches what a shape cannot — an employer named in prose, a town so small it
 * identifies the person, a licence or passport number, a named vessel or site. Returns the
 * offending strings so the caller can show the recruiter exactly what to remove.
 */
export const PiiReviewSchema = z.object({
  // `clean` is derived from findings, not trusted: a review that lists leaks and still says
  // clean must fail closed. kind/why are cosmetic — never let a missing label drop a finding.
  clean: z.boolean().optional(),
  findings: z.array(z.object({ text: z.string(), kind: z.string().default('pii'), why: z.string().default('') })).default([]),
}).transform((r) => ({ findings: r.findings, clean: r.findings.length === 0 }));
/**
 * The model is kept deliberately trigger-happy — a missed leak is far worse than a warning
 * the recruiter dismisses — and CODE decides what is permitted afterwards. Softening the
 * prompt to stop it flagging certificate numbers made it miss a name and a phone number, so
 * the allow-list lives here instead, where it is deterministic.
 *
 * `allowed` holds values we deliberately print (certificate numbers, certifying bodies, the
 * agency line). A finding is dropped only when it is itself one of those values or part of
 * one — never when an allowed value merely appears inside a longer finding, which would let
 * "Marko J., FROSIO Level II" through.
 */
export async function piiModelReview(clientFacingText: string, allowed: string[] = []) {
  const r = await askJson(
    PiiReviewSchema,
    'This text is about to be sent to a client as an ANONYMISED candidate summary. It must not identify the candidate or their current/previous employers. Find anything that does: personal names, employer or agency names, phone numbers, emails, addresses, dates of birth, passport/licence/ID numbers, social or portfolio links, a named vessel/site/project so specific it identifies the person, or an unusually small home town. Certificate numbers, certifying bodies (FROSIO, BINDT, IRATA...), countries, years, trades, rotations and languages are all FINE and must not be reported. Quote each offending span verbatim in `text`. clean = true only when you find nothing.',
    clientFacingText.slice(0, 20000),
  );
  const ok = allowed.filter(Boolean).map((a) => a.toLowerCase().trim());
  const findings = r.findings.filter((f) => {
    const t = f.text.toLowerCase().trim();
    return !!t && !ok.some((a) => a.includes(t));
  });
  return { findings, clean: findings.length === 0 };
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
