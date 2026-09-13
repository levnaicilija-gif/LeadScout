/**
 * The TED search API — the EU Publications Office's register of published procurement notices.
 *
 * What was confirmed against the live API on 2026-09-13, before any of this was written:
 *   · POST https://api.ted.europa.eu/v3/notices/search answers without a key. The docs say so:
 *     "TED API allows anonymous access to all services manipulating published notices".
 *   · No rate limit is documented and no rate-limit header is sent, but one is enforced: 25
 *     back-to-back requests got 10 answers and then 429s. Sixty requests a second apart, after
 *     a minute's pause, were all answered. So requests here are spaced 1.1 s apart and a 429
 *     backs off and retries rather than failing the run.
 *   · `classification-cpv IN (…)` matches a code's descendants.
 *   · Multilingual fields come back as { lang: value }, and a field the notice does not fill is
 *     simply absent — winner-name was missing on 93 of a 250-notice sample.
 */
const ENDPOINT = 'https://api.ted.europa.eu/v3/notices/search';
const GAP_MS = 1100;

export type TedRecord = Record<string, any>;
export type TedSearch = { query: string; fields: string[]; limit: number; page: number };
export type TedPage = { notices: TedRecord[]; totalNoticeCount: number };

/** What a run asked of TED, for its report. */
export const tedStats = { requests: 0, throttled: 0 };

let lastRequestAt = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function searchTed(body: TedSearch): Promise<TedPage> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastRequestAt + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    tedStats.requests++;
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    if (res.status === 429) {
      tedStats.throttled++;
      await sleep(5000 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`TED search answered HTTP ${res.status}: ${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    // An answer without a notices array is a query TED did not understand, not an empty day.
    if (!Array.isArray(json.notices)) throw new Error(`TED search returned no notices: ${text.slice(0, 300)}`);
    return { notices: json.notices, totalNoticeCount: Number(json.totalNoticeCount ?? json.notices.length) };
  }
  throw new Error('TED search refused six attempts in a row with HTTP 429');
}

/** The fields an award needs. Every name here was accepted by the live API. */
export const AWARD_FIELDS = [
  'publication-number', 'notice-type', 'publication-date',
  'buyer-name', 'buyer-country',
  'winner-name', 'winner-internet-address',
  'total-value', 'total-value-cur', 'result-value-notice', 'result-value-cur-notice',
  'notice-title', 'title-proc', 'description-proc',
  'classification-cpv', 'main-classification-proc',
  'winner-decision-date', 'contract-conclusion-date',
  'place-of-performance-country-lot', 'place-of-performance-country-proc', 'place-of-performance-city-lot',
];
