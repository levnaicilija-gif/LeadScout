import { z } from 'zod';
import { askJson, claude, MODEL_EXTRACT } from './claude';

export const CertSchema = z.object({
  doc_type: z.enum(['certificate', 'passport', 'cv', 'medical', 'a1', 'test_report', 'contract', 'other']),
  cert_body: z.string().optional(), // frosio|pcn|cswip|ampp|irata|winda|cisrs|iso9606|electrical_dk|other
  issuer: z.string().optional(), number: z.string().optional(), holder: z.string().optional(),
  level: z.string().optional(), process: z.string().optional(), position: z.string().optional(),
  method: z.string().optional(), scope: z.string().optional(),
  /** yyyy-mm-dd. Printed on passports and on some certificates; CSWIP verifies on it. */
  dob: z.string().optional(),
  /** Verification URL or QR-code target printed on the certificate — the only way to check a FROSIO/Accredible credential. */
  credential_url: z.string().optional(),
  issued: z.string().optional(), expiry: z.string().optional(), unreadable: z.array(z.string()).default([]),
  /** Employment contract. Rate, allowances, pension and date of birth are deliberately absent:
   *  they stay in the file itself and never reach a profile, a bullet or any PDF. */
  employer: z.string().optional(), role: z.string().optional(), workplace: z.string().optional(),
  rotation: z.string().optional(), start: z.string().optional(), end: z.string().optional(),
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
  "doc_type": "certificate | passport | cv | medical | a1 | test_report | contract | other",
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
  "employer": "contract only: the employing company",
  "role": "contract only: the position",
  "workplace": "contract only: the site or vessel",
  "rotation": "contract only: e.g. 4:2",
  "start": "contract only: start date",
  "end": "contract only: end date",
  "unreadable": ["names of fields you could not read"]
}

doc_type and unreadable are required. Omit any other key whose value is not on the document — never guess one.

contract means an employment agreement between a person and an employer: parties, position, dates, workplace. It is NOT a CV. holder must be the person named on the document, copied exactly as printed — if you cannot find a name, omit holder rather than shortening or inventing one.

NEVER return pay rate, allowances, pension, bonus or bank details, on any document type. They are not wanted and must not appear in the JSON. Return the JSON only, with no prose and no markdown fences.`,
    messages: [{ role: 'user', content: [...(source as any[]), { type: 'text', text: 'Extract.' }] as any }],
  });
  const text = r.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');
  return CertSchema.parse(JSON.parse(text.match(/\{[\s\S]*\}/)![0]));
}

export const ProfileSchema = z.object({
  full_name: z.string().optional(), trade: z.string(), trade_code: z.enum(['P', 'W', 'F', 'N', 'R', 'E', 'O']).default('O'),
  /** Every trade the CV actually supports. trade is the headline; a blaster who also insulates
   *  must still match an insulation job, so the secondary trades are kept alongside it. */
  trades: z.array(z.string()).nullish().transform((v) => v ?? []),
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
  "trades": ["every trade the CV supports, lower case, e.g. painter, blaster, insulator, scaffolder — not just the headline one"],
  "certificates_claimed": ["each certificate named on the CV, as printed"],
  "projects": [{ "years": "2025-26", "type": "what the work was", "country": "country", "employer": "employer name", "rotation": "e.g. 8:2" }],
  "skills": ["skill"],
  "languages": ["language (level)"],
  "availability": "when they are free, as stated",
  "pii": { "phone": "", "email": "", "address": "", "dob": "yyyy-mm-dd" }
}

trade and trade_code are required. Omit any other key the CV does not state. Return the JSON only, with no prose and no markdown fences.`, cvText.slice(0, 30000));

export const anonymize = (p: Profile) => ({
  trade: p.trade, trades: p.trades, certificates: p.certificates_claimed,
  projects: p.projects.map(({ years, type, country, rotation }) => ({ years, type, country, rotation })), // employer dropped
  skills: p.skills, languages: p.languages, availability: p.availability,
});

/** PII check on the client-facing text. Regex first, then a model review. */
/**
 * Is this span something we deliberately print?
 *
 * Substring matching is not enough: the model quotes "cert. 12 8471" while the CV claims
 * "certificate 12 8471", and those do not contain one another. What identifies a certificate
 * is its digits, so a span is permitted when its digit run appears in an allowed value.
 */
export function isAllowedSpan(span: string, allowed: string[]) {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const digits = (s: string) => s.replace(/\D+/g, '');
  const s = norm(span);
  const d = digits(span);
  return allowed.filter(Boolean).some((a) => {
    const an = norm(a);
    if (an.includes(s)) return true;
    return d.length >= 4 && digits(a).includes(d);
  });
}

export function piiRegexHits(text: string, fullName?: string, employers: string[] = [], allowed: string[] = []) {
  const hits: string[] = [];
  const permitted = (span: string) => isAllowedSpan(span, allowed);

  // Quote the span, not just its shape: "phone-like number" alone leaves a recruiter with a
  // blocked CV and nothing to act on. The class excludes newlines on purpose — with \s it
  // bridged two lines and reported "2027. 2025-26", an expiry year meeting a date range.
  const phone = text.match(/\+?\d[\d().\-  \t]{7,}\d/g) ?? [];
  for (const m of phone) if (!permitted(m)) { hits.push(`phone-like number: "${m.trim()}"`); break; }
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
  for (const m of email) if (!permitted(m)) { hits.push(`email: "${m}"`); break; }

  if (fullName) {
    const part = fullName.split(/\s+/).find((n) => n.length > 2 && new RegExp(`\\b${n}\\b`, 'i').test(text));
    if (part) hits.push(`name: "${part}"`);
  }
  for (const e of employers) if (e && e.length > 3 && text.toLowerCase().includes(e.toLowerCase())) hits.push(`employer: "${e}"`);
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
  const findings = r.findings.filter((f) => !!f.text.trim() && !isAllowedSpan(f.text, allowed));
  return { findings, clean: findings.length === 0 };
}

export const BulletsSchema = z.object({ bullets: z.array(z.string()).length(3) });

const BULLETS_SYSTEM = `Write exactly three bullets describing this candidate for a client.

State only what the data says: what they hold, what they did, and when they are available.
Every noun and number must come from the data given to you.

Do NOT write:
- benefits, savings or outcomes for the client ("reduces QC costs", "cuts mobilisation time",
  "proving deepwater experience") — these are claims about the future, not facts on file;
- adjectives of quality ("proven", "highly experienced", "reliable", "strong track record");
- anything not present in the data, however reasonable it seems.

A good bullet reads like a record, not a pitch:
  "FROSIO Inspector Level II, certificate 12 8471, valid to 14 March 2028."
  "Offshore substation painting and blasting in Spain, 2025-26, 8:2 rotation."
  "Available from 4 October 2026; 2:2 or 8:2 rotations."

No name. No employer names. Max 28 words each.`;

export const clientBullets = (anon: object, verified: object[], jobContext?: string) =>
  askJson(BulletsSchema, BULLETS_SYSTEM, JSON.stringify({ candidate: anon, verified_certificates: verified, job: jobContext ?? null }));

/** Per-bullet verdict: which claims in it cannot be traced back to the source. */
export const BulletCheckSchema = z.object({
  results: z.array(z.object({
    i: z.number(),
    supported: z.boolean(),
    unsupported: z.array(z.string()).nullish().transform((v) => v ?? []),
  })).default([]),
});

export const checkBullets = (bullets: string[], source: object) =>
  askJson(
    BulletCheckSchema,
    `You are checking bullets about a job candidate against the ONLY data we hold on them. This is a factual audit, not editing.

For each bullet, list every claim that cannot be traced to the source data — an invented certificate, a date not present, a benefit or outcome for the client, a judgement of quality, a place or rotation not in the data. Quote each offending phrase verbatim in "unsupported".
A bullet is supported only when every claim in it appears in the source. Restating a source fact in different words is fine; adding anything is not.

Return {"results":[{"i":0,"supported":true,"unsupported":[]}]} with one entry per bullet, in order.`,
    JSON.stringify({ bullets: bullets.map((b, i) => ({ i, text: b })), source }),
  );

/**
 * Three bullets that survive an audit against the source.
 *
 * Generation alone drifts into selling — a run produced "reduces third-party QC costs" and
 * "cutting mobilisation time and equipment overhead", neither of which is anywhere in the CV.
 * So every bullet is checked against the same data it was written from, the failures are named
 * back to the model for one retry, and anything still unsupported is dropped rather than sent.
 */
export async function buildBullets(anon: object, verified: object[], jobContext?: string) {
  const source = { candidate: anon, verified_certificates: verified };
  let bullets = (await clientBullets(anon, verified, jobContext)).bullets;
  const dropped: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const { results } = await checkBullets(bullets, source);
    const bad = results.filter((r) => !r.supported);
    if (bad.length === 0) return { bullets, dropped };

    if (attempt === 0) {
      // Name the exact phrases and ask again, rather than throwing the whole set away.
      const complaint = bad.map((r) => `bullet ${r.i + 1}: remove ${r.unsupported.map((u) => `"${u}"`).join(', ')}`).join('; ');
      bullets = (await askJson(
        BulletsSchema,
        `${BULLETS_SYSTEM}\n\nA previous attempt failed the factual audit. Fix exactly these problems and change nothing else: ${complaint}`,
        JSON.stringify({ candidate: anon, verified_certificates: verified, job: jobContext ?? null }),
      )).bullets;
      continue;
    }
    // Still unsupported after the retry: drop those bullets. Two true bullets beat three with a lie.
    const badIdx = new Set(bad.map((r) => r.i));
    dropped.push(...bullets.filter((_, i) => badIdx.has(i)));
    bullets = bullets.filter((_, i) => !badIdx.has(i));
  }
  return { bullets, dropped };
}

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
