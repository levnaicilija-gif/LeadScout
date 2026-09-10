/**
 * Applicant tracking systems, and how to read a board without crawling it.
 *
 * Most European industrial companies do not run their own careers page: they embed a board from
 * one of a dozen ATS vendors, and nearly all of those publish the same list as JSON. Reading the
 * JSON is free, exact and needs no browser, so recognising the vendor is worth far more than any
 * amount of cleverness applied to the HTML.
 *
 * Every pattern here was written from a real board URL. Where a vendor has no public endpoint
 * the type is still recorded — knowing a company is on Teamtailor is useful even when the list
 * has to be read from the page.
 */
export type AtsType =
  | 'greenhouse' | 'lever' | 'workday' | 'smartrecruiters' | 'teamtailor' | 'recruitee'
  | 'personio' | 'workable' | 'ashby' | 'bamboohr' | 'jobylon' | 'easycruit' | 'reachmee'
  | 'hr_manager' | 'softgarden' | 'jobvite' | 'taleo' | 'icims' | 'successfactors' | 'oracle_cloud'
  | 'talentech' | 'varbi' | 'emply';

type Detector = { type: AtsType; re: RegExp; slug: (m: RegExpMatchArray) => string };

/** Ordered: the more specific host patterns first. */
const DETECTORS: Detector[] = [
  { type: 'greenhouse', re: /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i, slug: (m) => m[1] },
  { type: 'lever', re: /jobs\.lever\.co\/([a-z0-9_-]+)/i, slug: (m) => m[1] },
  { type: 'ashby', re: /jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i, slug: (m) => m[1] },
  { type: 'workable', re: /apply\.workable\.com\/([a-z0-9_-]+)/i, slug: (m) => m[1] },
  { type: 'recruitee', re: /([a-z0-9-]+)\.recruitee\.com/i, slug: (m) => m[1] },
  { type: 'teamtailor', re: /([a-z0-9-]+)\.teamtailor\.com/i, slug: (m) => m[1] },
  { type: 'personio', re: /([a-z0-9-]+)\.jobs\.personio\.(?:de|com)/i, slug: (m) => m[1] },
  { type: 'jobylon', re: /([a-z0-9-]+)\.jobylon\.com/i, slug: (m) => m[1] },
  { type: 'easycruit', re: /([a-z0-9-]+)\.easycruit\.com/i, slug: (m) => m[1] },
  { type: 'reachmee', re: /([a-z0-9-]+)\.reachmee\.com/i, slug: (m) => m[1] },
  { type: 'bamboohr', re: /([a-z0-9-]+)\.bamboohr\.com/i, slug: (m) => m[1] },
  { type: 'smartrecruiters', re: /(?:careers|jobs)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/i, slug: (m) => m[1] },
  { type: 'talentech', re: /jobs\.talentech\.com\/([A-Za-z0-9_-]+)/i, slug: (m) => m[1] },
  { type: 'varbi', re: /([a-z0-9-]+)\.varbi\.com/i, slug: (m) => m[1] },
  { type: 'emply', re: /([a-z0-9-]+)\.emply\.(?:net|com)/i, slug: (m) => m[1] },
  { type: 'hr_manager', re: /recruitment\.hr-manager\.net\/[^"']*?(?:company|customer)[=/]([A-Za-z0-9_-]+)/i, slug: (m) => m[1] },
  { type: 'softgarden', re: /([a-z0-9-]+)\.softgarden\.io/i, slug: (m) => m[1] },
  { type: 'workday', re: /([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/([A-Za-z0-9_-]+)/i, slug: (m) => `${m[1]}/${m[2]}/${m[3]}` },
  { type: 'successfactors', re: /career\d*\.successfactors\.(?:eu|com)\/[^"']*?company=([A-Za-z0-9]+)/i, slug: (m) => m[1] },
  { type: 'jobvite', re: /jobs\.jobvite\.com\/([a-z0-9_-]+)/i, slug: (m) => m[1] },
  { type: 'icims', re: /([a-z0-9-]+)\.icims\.com/i, slug: (m) => m[1] },
  { type: 'taleo', re: /([a-z0-9-]+)\.taleo\.net/i, slug: (m) => m[1] },
  { type: 'oracle_cloud', re: /([a-z0-9-]+)\.oraclecloud\.com\/hcmUI\/CandidateExperience/i, slug: (m) => m[1] },
];

/** The first ATS a page's HTML gives away, if any. */
export function detectAts(html: string): { type: AtsType; slug: string } | null {
  for (const d of DETECTORS) {
    const m = html.match(d.re);
    if (m) {
      const slug = d.slug(m);
      // A vendor's own marketing pages match their own pattern; a one-character slug never real.
      if (slug && slug.length > 1 && !/^(www|jobs|careers|embed|api)$/i.test(slug)) return { type: d.type, slug };
    }
  }
  return null;
}

export type AtsJob = { title: string; url: string; location?: string; postedAt?: string; description?: string };

/** Where a vendor publishes its board as JSON. null means the list has to come from the page. */
export function atsListUrl(type: AtsType, slug: string): string | null {
  switch (type) {
    case 'greenhouse': return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    case 'lever': return `https://api.lever.co/v0/postings/${slug}?mode=json`;
    case 'ashby': return `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`;
    case 'recruitee': return `https://${slug}.recruitee.com/api/offers/`;
    case 'workable': return `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`;
    case 'smartrecruiters': return `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`;
    case 'personio': return `https://${slug}.jobs.personio.de/xml`;
    default: return null;
  }
}

const str = (v: any) => (typeof v === 'string' ? v : '');

/** Normalise each vendor's own shape into the one this codebase uses. */
export function parseAtsJobs(type: AtsType, slug: string, body: string): AtsJob[] {
  // Personio publishes XML, everyone else JSON.
  if (type === 'personio') {
    const out: AtsJob[] = [];
    for (const m of body.matchAll(/<position>([\s\S]*?)<\/position>/gi)) {
      const block = m[1];
      const pick = (tag: string) => (block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i')) ?? [])[1]?.trim();
      const id = pick('id');
      const title = pick('name');
      if (title && id) out.push({ title, url: `https://${slug}.jobs.personio.de/job/${id}`, location: pick('office'), description: pick('jobDescriptions')?.replace(/<[^>]+>/g, ' ').slice(0, 6000) });
    }
    return out;
  }

  let j: any;
  try { j = JSON.parse(body); } catch { return []; }
  const plain = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);

  switch (type) {
    case 'greenhouse':
      return (j.jobs ?? []).map((x: any) => ({ title: str(x.title), url: str(x.absolute_url), location: str(x.location?.name), postedAt: str(x.updated_at), description: x.content ? plain(String(x.content)) : undefined }));
    case 'lever':
      return (Array.isArray(j) ? j : []).map((x: any) => ({ title: str(x.text), url: str(x.hostedUrl), location: str(x.categories?.location), postedAt: x.createdAt ? new Date(x.createdAt).toISOString() : undefined, description: x.descriptionPlain ? String(x.descriptionPlain).slice(0, 6000) : undefined }));
    case 'ashby':
      return (j.jobs ?? []).map((x: any) => ({ title: str(x.title), url: str(x.jobUrl), location: str(x.location), postedAt: str(x.publishedAt), description: x.descriptionPlain ? String(x.descriptionPlain).slice(0, 6000) : undefined }));
    case 'recruitee':
      return (j.offers ?? []).map((x: any) => ({ title: str(x.title), url: str(x.careers_url) || `https://${slug}.recruitee.com/o/${str(x.slug)}`, location: [str(x.city), str(x.country_code)].filter(Boolean).join(', '), postedAt: str(x.published_at), description: x.description ? plain(String(x.description)) : undefined }));
    case 'workable':
      return (j.jobs ?? []).map((x: any) => ({ title: str(x.title), url: str(x.url) || str(x.application_url), location: [str(x.city), str(x.country)].filter(Boolean).join(', '), postedAt: str(x.published_on), description: x.description ? plain(String(x.description)) : undefined }));
    case 'smartrecruiters':
      return (j.content ?? []).map((x: any) => ({ title: str(x.name), url: `https://jobs.smartrecruiters.com/${slug}/${str(x.id)}`, location: [str(x.location?.city), str(x.location?.country)].filter(Boolean).join(', '), postedAt: str(x.releasedDate) }));
    default:
      return [];
  }
}

/**
 * Workday needs a POST, so it cannot be expressed as a list URL. It is worth the special case:
 * it is what most large industrial groups run, and the endpoint returns the whole board.
 * The slug is stored as "tenant/wdN/site".
 */
export function workdayParts(slug: string) {
  const [tenant, wd, site] = slug.split('/');
  return tenant && wd && site ? { tenant, wd, site } : null;
}

export async function fetchWorkday(slug: string, post: (url: string, body: string) => Promise<{ ok: boolean; body: string }>): Promise<AtsJob[]> {
  const parts = workdayParts(slug);
  if (!parts) return [];
  const { tenant, wd, site } = parts;
  const base = `https://${tenant}.${wd}.myworkdayjobs.com`;
  const r = await post(`${base}/wday/cxs/${tenant}/${site}/jobs`, JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' }));
  if (!r.ok) return [];
  let j: any;
  try { j = JSON.parse(r.body); } catch { return []; }
  return (j.jobPostings ?? []).map((x: any) => ({
    title: str(x.title),
    url: `${base}/${site}${str(x.externalPath)}`,
    location: str(x.locationsText),
    postedAt: str(x.postedOn),
  })).filter((x: AtsJob) => x.title);
}

/** A board's own public address, for a company whose site never linked to it plainly. */
export function atsHomeUrl(type: AtsType, slug: string): string | null {
  switch (type) {
    case 'greenhouse': return `https://boards.greenhouse.io/${slug}`;
    case 'lever': return `https://jobs.lever.co/${slug}`;
    case 'ashby': return `https://jobs.ashbyhq.com/${slug}`;
    case 'workable': return `https://apply.workable.com/${slug}`;
    case 'recruitee': return `https://${slug}.recruitee.com`;
    case 'teamtailor': return `https://${slug}.teamtailor.com/jobs`;
    case 'personio': return `https://${slug}.jobs.personio.de`;
    case 'jobylon': return `https://${slug}.jobylon.com`;
    case 'easycruit': return `https://${slug}.easycruit.com`;
    case 'smartrecruiters': return `https://jobs.smartrecruiters.com/${slug}`;
    case 'bamboohr': return `https://${slug}.bamboohr.com/careers`;
    case 'workday': { const p = workdayParts(slug); return p ? `https://${p.tenant}.${p.wd}.myworkdayjobs.com/${p.site}` : null; }
    default: return null;
  }
}

/** Words a careers link uses, in the languages our companies publish in. */
export const CAREERS_WORDS = /\b(careers?|jobs?|vacanc(?:y|ies)|vacatures?|werken[- ]bij|werkenbij|karriere|karriär|karriere|kariera|jobb|ledige[- ]stillinger|stillinger|lediga[- ]jobb|emplois|carrière|carrieres|offres[- ]d.emploi|empleo|trabaja|lavora[- ]con[- ]noi|posizioni|praca|join[- ]us|work[- ]with[- ]us|work[- ]for[- ]us|open[- ]positions|recruitment)\b/i;
