/**
 * Applicant tracking systems.
 *
 * A careers page hosted on an ATS almost always has a JSON endpoint behind it. Reading that
 * is far cheaper than crawling the page — no browser, no HTML parsing, and the fields
 * (title, location, posted date, url) come already separated. Detection is by host, because
 * that is what a company's "careers" link actually points at.
 *
 * `jobsUrl` is only set for providers whose public JSON endpoint is documented and confirmed;
 * for the rest we record the ats_type (still useful — it tells us the page is a job board and
 * how to read it) and fall back to fetching the careers page.
 */
export type AtsType =
  | 'greenhouse' | 'lever' | 'workable' | 'recruitee' | 'teamtailor'
  | 'smartrecruiters' | 'jobylon' | 'emply' | 'hr-on';

type Provider = {
  type: AtsType;
  /** Pull the board slug out of a careers URL. */
  slug: (u: URL) => string | undefined;
  /** Public JSON listing, when the provider has a confirmed one. */
  jobsUrl?: (slug: string) => string;
  /** Read the provider's payload into a common shape. */
  parse?: (json: any) => AtsJob[];
};

export type AtsJob = { externalId: string; title: string; location?: string; url: string; postedAt?: string; description?: string };

const firstPath = (u: URL) => u.pathname.split('/').filter(Boolean)[0];
const sub = (u: URL) => u.hostname.split('.')[0];
const iso = (d: unknown) => { const s = String(d ?? ''); const t = Date.parse(s); return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10); };

export const PROVIDERS: Provider[] = [
  {
    type: 'greenhouse',
    slug: (u) => (/(^|\.)greenhouse\.io$/.test(u.hostname) ? firstPath(u) : undefined),
    jobsUrl: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=true`,
    parse: (j) => (j?.jobs ?? []).map((x: any) => ({ externalId: String(x.id), title: x.title, location: x.location?.name, url: x.absolute_url, postedAt: iso(x.updated_at), description: x.content })),
  },
  {
    type: 'lever',
    slug: (u) => (/(^|\.)lever\.co$/.test(u.hostname) ? firstPath(u) : undefined),
    jobsUrl: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
    parse: (j) => (Array.isArray(j) ? j : []).map((x: any) => ({ externalId: String(x.id), title: x.text, location: x.categories?.location, url: x.hostedUrl, postedAt: iso(x.createdAt), description: x.descriptionPlain })),
  },
  {
    type: 'recruitee',
    slug: (u) => (/(^|\.)recruitee\.com$/.test(u.hostname) ? sub(u) : undefined),
    jobsUrl: (s) => `https://${s}.recruitee.com/api/offers/`,
    parse: (j) => (j?.offers ?? []).map((x: any) => ({ externalId: String(x.id), title: x.title, location: [x.city, x.country].filter(Boolean).join(', '), url: x.careers_url ?? x.url, postedAt: iso(x.published_at), description: x.description })),
  },
  {
    type: 'smartrecruiters',
    slug: (u) => (/(^|\.)smartrecruiters\.com$/.test(u.hostname) ? firstPath(u) : undefined),
    jobsUrl: (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=100`,
    parse: (j) => (j?.content ?? []).map((x: any) => ({ externalId: String(x.id), title: x.name, location: [x.location?.city, x.location?.country].filter(Boolean).join(', '), url: x.ref ?? `https://jobs.smartrecruiters.com/${x.company?.identifier}/${x.id}`, postedAt: iso(x.releasedDate) })),
  },
  {
    type: 'workable',
    slug: (u) => (/(^|\.)workable\.com$/.test(u.hostname) ? (u.hostname.startsWith('apply.') ? firstPath(u) : sub(u)) : undefined),
    jobsUrl: (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`,
    parse: (j) => (j?.jobs ?? []).map((x: any) => ({ externalId: String(x.shortcode ?? x.id), title: x.title, location: [x.city, x.country].filter(Boolean).join(', '), url: x.url ?? x.application_url, postedAt: iso(x.published_on ?? x.created_at), description: x.description })),
  },
  // Detected but read as HTML: these have no public JSON listing without a per-customer token.
  { type: 'teamtailor', slug: (u) => (/(^|\.)teamtailor\.com$/.test(u.hostname) ? sub(u) : undefined) },
  { type: 'jobylon', slug: (u) => (/(^|\.)jobylon\.com$/.test(u.hostname) ? sub(u) : undefined) },
  { type: 'emply', slug: (u) => (/(^|\.)emply\.(com|net)$/.test(u.hostname) ? sub(u) : undefined) },
  { type: 'hr-on', slug: (u) => (/(^|\.)hr-on\.com$/.test(u.hostname) ? sub(u) : undefined) },
];

export function detectAts(url: string): { type: AtsType; slug: string } | undefined {
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  for (const p of PROVIDERS) {
    const slug = p.slug(u);
    if (slug) return { type: p.type, slug };
  }
  return undefined;
}

export const providerFor = (type: string) => PROVIDERS.find((p) => p.type === type);
export const hasJsonFeed = (type: string) => !!providerFor(type)?.jobsUrl;

/** Careers-link wording across RFBT's countries. */
export const CAREERS_WORDS = [
  'career', 'careers', 'jobs', 'job', 'vacancy', 'vacancies', 'work with us', 'working at', 'join us',
  'karriere', 'karriere', 'stillinger', 'ledige stillinger', 'ledige job', 'jobb', 'lediga jobb',
  'vacatures', 'werken bij', 'empleo', 'trabaja con nosotros', 'carrière', 'emploi', 'offres',
  'kariera', 'praca', 'ura', 'avoimet', 'stellenangebote', 'stellen', 'lavoro',
];
