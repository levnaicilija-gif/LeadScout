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
  // A span only looks like a phone number if it carries enough digits to be one. Nine is the
  // shortest international subscriber number; a date range like "2023-2025" has eight, and it
  // was blocking a perfectly clean CV.
  const phone = (text.match(/\+?\d[\d().\-  \t]{7,}\d/g) ?? []).filter((m) => m.replace(/\D/g, '').length >= 9);
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
    `This text is about to be sent to a client as an ANONYMISED candidate summary. It must not identify the candidate or their current/previous employers. Find anything that does: personal names, employer or agency names, phone numbers, emails, addresses, dates of birth, passport/licence/ID numbers, social or portfolio links, a named vessel/site/project so specific it identifies the person, or an unusually small home town. Certificate numbers, certifying bodies (FROSIO, BINDT, IRATA...), countries, years, trades, rotations and languages are all FINE and must not be reported.

A named project counts only when it would single this person out — a small crew, a rare role, one vessel. Large works that employ hundreds or thousands (a bridge, a motorway, a refinery turnaround, a wind farm, a shipyard) identify nobody and must NOT be reported: saying what the candidate has worked on is the point of the summary.

Quote each offending span verbatim in "text". clean = true only when you find nothing.`,
    clientFacingText.slice(0, 20000),
  );
  const findings = r.findings.filter((f) => !!f.text.trim() && !isAllowedSpan(f.text, allowed));
  return { findings, clean: findings.length === 0 };
}

/**
 * The model is asked for {"bullets": [...]} and mostly obliges, but a real CV came back under
 * some other key and the whole client version was lost to a zod error the recruiter could do
 * nothing about. Three bullets is the house style, not a fact worth failing over: take what
 * came back whatever it was called, and let the audit in buildBullets decide what survives.
 */
const toBullets = (v: any) => {
  const strings = (a: any): string[] | null =>
    Array.isArray(a) && a.length
      ? a.map((x) => (typeof x === 'string' ? x : x?.text ?? x?.bullet ?? x?.content ?? '')).filter((s: string) => typeof s === 'string' && s.trim())
      : null;
  if (Array.isArray(v)) return { bullets: strings(v) ?? [] };
  if (v && typeof v === 'object') {
    if (strings(v.bullets)) return { ...v, bullets: strings(v.bullets) };
    // Named something else: take the first array of strings the object offers.
    for (const val of Object.values(v)) { const s = strings(val); if (s) return { ...v, bullets: s }; }
  }
  return v;
};

export const BulletsSchema = z.preprocess(toBullets, z.object({
  bullets: z.array(z.string().trim().min(1)).min(1).max(8).transform((b) => b.slice(0, 3)),
}));

const BULLETS_SYSTEM = `Write exactly three bullets describing this candidate for a client.

Return JSON in exactly this shape, with exactly this key:
{"bullets":["first bullet","second bullet","third bullet"]}

State only what the data says: what they hold, what they did, and when they are available.
Every noun and number must come from the data given to you.

CERTIFICATES — the rule that matters most:
- A certificate in verified_certificates has been checked with the issuer. Only those may be
  stated plainly as held: "PCN Level 2 UT, verified on the BINDT register, valid to 21/03/2029".
- A certificate in claimed_certificates has NOT been checked. It appears on the CV and nowhere
  else. Either leave it out, or mark it exactly as the candidate's own claim:
  "FROSIO Inspector Level III per CV, verification pending".
- Never merge the two, and never let a claimed certificate borrow the authority of a verified
  one by sitting in the same sentence.

Do NOT write:
- benefits, savings or outcomes for the client ("reduces QC costs", "cuts mobilisation time",
  "proving deepwater experience") — these are claims about the future, not facts on file;
- adjectives of quality ("proven", "highly experienced", "reliable", "strong track record");
- anything not present in the data, however reasonable it seems.

A good bullet reads like a record, not a pitch:
  "PCN Level 2 UT, verified on the BINDT register, valid to 21 March 2029."
  "FROSIO Inspector Level III per CV, verification pending."
  "Offshore substation painting and blasting in Spain, 2025-26, 8:2 rotation."
  "Available from 4 October 2026; 2:2 or 8:2 rotations."

No name. No employer names. Max 28 words each.`;

export const clientBullets = (anon: any, verified: object[], jobContext?: string) =>
  askJson(BulletsSchema, BULLETS_SYSTEM, JSON.stringify({
    candidate: { ...anon, certificates: undefined },
    verified_certificates: verified,
    claimed_certificates: anon?.certificates ?? [],
    job: jobContext ?? null,
  }));

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

A certificate from claimed_certificates stated as fact — without "per CV" or "verification pending" — is UNSUPPORTED, however clearly it appears on the CV: the client would read it as checked when it is not.

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
  const source = { candidate: { ...(anon as any), certificates: undefined }, verified_certificates: verified, claimed_certificates: (anon as any)?.certificates ?? [] };
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

/** fits/missing/blockers come back as a single string often enough to be worth accepting. */
const listOfText = z.preprocess(
  (v: any) => (typeof v === 'string' ? v.split(/\s*[;·•]\s*|\n+/).map((t) => t.trim()).filter(Boolean) : v ?? []),
  z.array(z.string()),
);
export const ScoreSchema = z.object({ score: z.number().min(0).max(100), fits: listOfText, missing: listOfText, blockers: listOfText });
export const scoreAgainstJob = (anon: object, verified: object[], jd: string) =>
  askJson(ScoreSchema, 'Score how well this candidate matches the job (0–100). fits: evidence from the CV. missing: what is absent and what would close it (e.g. "ICATS card — FROSIO accepted by most UK yards, confirm"). blockers: hard requirements not met (passport, required cert level, language). Be strict and specific.', JSON.stringify({ candidate: anon, verified_certificates: verified, job: jd }));

export const JdSchema = z.object({ job_description: z.string(), assumptions: z.array(z.string()) });
export const jdFromLead = (lead: object, articleText: string) =>
  askJson(JdSchema, 'Write a working job description for a trades staffing agency from this lead. Use only stated facts; where you must assume (typical certs for this company type, rotation), list each assumption separately so the recruiter can confirm on the call.', JSON.stringify({ lead, source_text: articleText.slice(0, 8000) }));

/** The nested keys drift as readily as the top-level ones, and askJson can only name those. */
const Question = z.preprocess((v: any) => {
  if (typeof v === 'string') return { q: v, good_answer: '' };
  if (!v || typeof v !== 'object') return v;
  return {
    q: v.q ?? v.question ?? v.text ?? '',
    good_answer: v.good_answer ?? v.good ?? v.answer ?? v.good_answer_sounds_like ?? v.ideal_answer ?? '',
  };
}, z.object({ q: z.string().min(1), good_answer: z.string() }));

export const QuestionsSchema = z.object({ questions: z.array(Question).min(1).max(12) });
export const screeningQuestions = (jd: string) =>
  askJson(QuestionsSchema, `Write 6–8 screening questions a recruiter asks a candidate for this role: technical (process/positions/standards), certificates and expiry, rotation history, offshore medical/safety training, passport/A1, English on site, rate and start, conflicts. For each, what a good answer sounds like.

"today" is the current date. Any date in the job that is already past is history, not a plan: never ask a candidate whether they can start on a date that has gone. Ask for the earliest date they could mobilise, and about notice period, instead.

Each entry in "questions" is an object with exactly these keys:
{"q":"the question the recruiter asks","good_answer":"what a good answer sounds like"}`, JSON.stringify({ job: jd, today: new Date().toISOString().slice(0, 10) }), undefined, 4000);

/** email and linkedin came back as objects ({subject, body}) rather than the plain text asked for. */
const flat = (v: any): string => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(flat).filter(Boolean).join('\n');
  if (v && typeof v === 'object') return [v.body, v.text, v.message, v.content].find((x) => typeof x === 'string') ?? Object.values(v).map(flat).filter(Boolean).join('\n');
  return '';
};

/**
 * Screening questions for one candidate rather than for a job in the abstract.
 *
 * With a job attached they are generated from the score: the first questions go straight at the
 * blockers and the gaps, because those are what decide whether this person can be put forward.
 * Without one they cover the trade — processes, certificates, rotation, safety, right to work.
 */
export const candidateScreening = (candidate: object, verified: object[], job?: string | null, score?: object | null) =>
  askJson(QuestionsSchema, `Write 6-8 screening questions a recruiter asks THIS candidate, in the order they should be asked.

${job ? `A job is attached, and so is the score against it. Lead with the score: every blocker gets a question, then every item in "missing". Ask what would close the gap, not whether it exists — the recruiter can already see that it does. Only then ask the general trade questions.` : 'No job is attached, so cover the trade: processes, positions and standards; certificates and expiry; rotation history; offshore medical and safety training; passport, A1 and right to work; English on site; rate and earliest mobilisation.'}

Ground every question in what the candidate's own data says. A certificate in verified_certificates has been confirmed — do not ask whether they hold it; ask about scope, expiry or renewal. A certificate the CV claims but nothing confirms is exactly what to ask for evidence of.

"today" is the current date: never ask about a start date that has already passed — ask for the earliest date they could mobilise.

Each entry in "questions" is an object with exactly these keys:
{"q":"the question the recruiter asks","good_answer":"what a good answer sounds like"}`,
    JSON.stringify({ candidate, verified_certificates: verified, job: job ?? null, score: score ?? null, today: new Date().toISOString().slice(0, 10) }),
    undefined, 4000);

export const OutreachSchema = z.preprocess((v: any) => {
  if (!v || typeof v !== 'object') return v;
  const email = v.email ?? v.body ?? v.message;
  return {
    ...v,
    subject: typeof v.subject === 'string' ? v.subject : (typeof email === 'object' && email ? email.subject ?? '' : ''),
    email: flat(email),
    linkedin: flat(v.linkedin ?? v.linkedin_message ?? v.connection_message),
    reasoning: flat(v.reasoning ?? v.why ?? ''),
  };
}, z.object({ subject: z.string(), email: z.string().min(1), linkedin: z.string().max(600), reasoning: z.string() }));

/** Which claims in a drafted email cannot be traced to the data behind it. */
export const DraftCheckSchema = z.object({
  unsupported: z.array(z.object({ phrase: z.string(), why: z.string() })).nullish().transform((v) => v ?? []),
});

export const checkDraft = (draft: { subject: string; email: string; linkedin: string }, source: object) =>
  askJson(
    DraftCheckSchema,
    `You are auditing an outreach email against the ONLY data behind it. This is a factual audit, not editing.

Quote verbatim every phrase in the subject, email or LinkedIn message that states something about OUR candidates which cannot be traced to "pool":
- a certificate, standard, level or number not in pool.verified_certificates;
- a count of people not supported by pool.available or pool.candidates_on_file;
- a trade not in pool.trades;
- a country, site or project not in pool.projects — a country counts as traceable when it appears in any pool.projects entry;
- a claim about speed, quality, price or outcome, which is never in the data.

Claims about the CLIENT — their contract, assets, timing, and their own quoted words — come from the lead and are not your concern here.

Return {"unsupported":[{"phrase":"...","why":"..."}]}, empty when everything traces.`,
    JSON.stringify({ draft, source }),
  );

export const draftOutreach = (ctx: object) =>
  askJson(OutreachSchema, `Draft an outreach email and a LinkedIn connection message (<300 chars) from a staffing agency to this decision-maker. Open with their own quote or the posting. Ask for one small step. Short. reasoning: one line on why it is written this way.

THE POOL. Everything you say about our candidates must come from "pool" in the data below, and nothing else. It lists what we actually hold today.
- Name a certificate, a standard, a level or a number ONLY if it appears in pool.verified_certificates. That list is what has been checked with the issuer.
- If pool.verified_certificates is empty, say so plainly — "candidates screened and certificates being verified now" — and do not name a single certificate or standard. An invented "EN 9606" or "NDT Level II" in a first email is a lie to a client and ends the relationship.
- Give a number of available people only if pool.available says one. Never write "5-6 pre-vetted tradespeople" unless the pool says there are.
- Prior projects: only those in pool.projects.

Everything about THEIR side — the contract, the assets, the timing — comes from the lead and the quote, copied not embroidered.

WHO IT GOES TO. "recipient" is the person to address. "hook" is the person whose words open the email — often not the same person, because newspapers quote chief executives and chief executives do not book trades. Greet the recipient by first name; quote the hook and attribute the words to them by name and title. Never address the hook as though they were the recipient.

DATES. "today" is the current date. Treat any date before it as past: a contract that started in March when it is now September is running, not starting, so ask about the earliest date someone could mobilise rather than about a start that has already happened.

"subject", "email", "linkedin" and "reasoning" are each PLAIN TEXT, not nested objects. Put the subject line in "subject" and the body in "email". Begin "reasoning" with why this recipient was chosen.`, JSON.stringify({ ...ctx, today: new Date().toISOString().slice(0, 10) }));

/**
 * Draft, then audit what it says about our own people, and give it one chance to correct
 * itself. A first email that claims a certificate we do not hold ends the relationship.
 */
export async function draftOutreachChecked(ctx: any) {
  let d = await draftOutreach(ctx);
  const source = { pool: ctx.pool ?? null };
  const audit = await checkDraft(d, source);
  if (audit.unsupported.length === 0) return { ...d, unsupported: [] as { phrase: string; why: string }[] };

  const complaint = audit.unsupported.map((u) => `"${u.phrase}" — ${u.why}`).join('; ');
  d = await draftOutreach({ ...ctx, _correction: `A previous draft claimed things the data does not support. Remove or rewrite exactly these, and change nothing else: ${complaint}` });
  const second = await checkDraft(d, source);
  // Still unsupported: hand it over with the phrases named, rather than quietly sending it.
  return { ...d, unsupported: second.unsupported };
}
