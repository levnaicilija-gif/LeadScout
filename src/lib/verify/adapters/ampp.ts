import { httpPost } from '@/lib/http';
import type { Adapter, LookupInput, LookupResult, SourceCertificate } from './types';

/**
 * AMPP (formerly NACE / SSPC) — the public credential registry. NO BROWSER, NO LOGIN, NO CAPTCHA.
 *
 * Confirmed against the live site on 2026-09-15 (item 23):
 *   Entry  ampp.org "Find A Certified Professional" → https://nace.useclarus.com/view/verify/
 *          (the old https://www.ampp.org/resources/impact/certification-search is a 404)
 *   API    the page's /view/static/verify_credential.js posts JSON to
 *            POST https://nace.useclarus.com/data_api/view_credential_verification
 *            {"filter_join":"and","filter_expression":["number startswith <n>","last_name startswith <name>"],"limit":<n>}
 *          and answers {"data":[...]}; a made-up number answers {"data": []}. Cache-Control: no-store; no rate-limit headers.
 *   Row    user_id, first_name, last_name, city, postal_code, state, country, address1, address2, contact_phone, number,
 *          cred_slug, credential_type_name, credential_id, agg_data.agg_data[] of
 *            { name, slug, number, issued_on (yyyy-mm-dd), renewal_start, credential_type, expiration_date, program_category }
 *   AMPP   "Search results for AMPP credential holders reflect candidates who are considered current/active and have opted
 *          to display their credentials in the registry." So NOT BEING LISTED IS NOT A VERDICT: a holder who opted out, or
 *          one whose credential lapsed, is simply absent. Absence goes to AMPP by email; only a listed credential is valid.
 *
 * Contact details, address and city are never kept: the result carries the holder's name and the credential rows only.
 * Not yet seen on a real candidate's certificate (none on file on 2026-09-15); the row shape above is from the live registry.
 */
const PAGE_URL = 'https://nace.useclarus.com/view/verify/';
const API_URL = 'https://nace.useclarus.com/data_api/view_credential_verification';
const LIMIT = 25;

/** The registry's filter is a string; only what a certificate number or a surname can contain goes into it. */
export const amppNumber = (s?: string) => (s ?? '').trim().replace(/[^A-Za-z0-9-]/g, '');
export const amppSurname = (holder?: string) => ((holder ?? '').trim().split(/\s+/).filter(Boolean).pop() ?? '').replace(/[^\p{L}'-]/gu, '');
const fold = (s?: string) => (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, '');

type AmppCredential = { name?: string; slug?: string; number?: string; issued_on?: string; expiration_date?: string; program_category?: string };
type AmppRow = { first_name?: string; last_name?: string; number?: string; agg_data?: { agg_data?: AmppCredential[] } };

/** Read the registry's answer for one certificate. Pure, so scripts/verify-adapters-check.ts holds it to the rules. */
export function readAmpp(rows: AmppRow[], input: LookupInput, checkedAt: string, today = new Date().toISOString().slice(0, 10)): LookupResult {
  const base = { checkedWhere: PAGE_URL, checkedAt };
  const wantNo = fold(amppNumber(input.number));
  const wantSurname = fold(amppSurname(input.holder));
  const notListed = (why: string): LookupResult => ({
    ...base, result: 'not_supported',
    notes: `${why} AMPP's public registry lists only current holders who opted in, so this is not a verdict — confirm with AMPP.`,
  });

  const people = rows.filter((r) => !wantSurname || fold(r.last_name) === wantSurname);
  const credsOf = (r: AmppRow) => (r.agg_data?.agg_data ?? []).filter((c) => c && (c.number || c.name));
  const holdsNumber = (r: AmppRow) => !!wantNo && (fold(r.number) === wantNo || credsOf(r).some((c) => fold(c.number) === wantNo));
  const matches = wantNo ? people.filter(holdsNumber) : people;

  if (matches.length === 0) {
    return notListed(wantNo ? `No listing for certification number ${amppNumber(input.number)}${wantSurname ? ` with surname "${amppSurname(input.holder)}"` : ''}.` : `No listing for surname "${amppSurname(input.holder)}".`);
  }
  if (matches.length > 1) {
    return { ...base, result: 'not_supported', notes: `${matches.length} AMPP holders match ${wantNo ? `number ${amppNumber(input.number)}` : `surname "${amppSurname(input.holder)}"`}; none can be picked without the certification number and surname together.` };
  }

  const person = matches[0];
  const certificates: SourceCertificate[] = credsOf(person).map((c) => ({
    number: c.number, method: c.name, scope: c.program_category, issued: c.issued_on, expiry: c.expiration_date,
  }));
  const level = String(input.level ?? '').match(/\d/)?.[0];
  const credential =
    certificates.find((c) => !!wantNo && fold(c.number) === wantNo) ??
    (level ? certificates.filter((c) => new RegExp(`\\b(level\\s*)?${level}\\b`, 'i').test(c.method ?? '')) : []).at(0) ??
    (certificates.length === 1 ? certificates[0] : undefined);
  const holderOnSource = [person.first_name, person.last_name].filter(Boolean).join(' ') || undefined;
  const listed = certificates.map((c) => `${c.method ?? '?'} — ${c.number ?? '?'} issued ${c.issued ?? '?'} expires ${c.expiry ?? '?'}`).join(' · ');

  if (!credential) {
    return { ...base, result: 'not_supported', holderOnSource, certificates, notes: `The holder is listed, but no credential could be matched to this certificate${input.level ? ` (level ${input.level})` : ''}. Listed: ${listed}` };
  }
  const expired = !!credential.expiry && credential.expiry < today;
  return {
    ...base, result: expired ? 'invalid' : 'valid', holderOnSource, certificates, validUntil: credential.expiry,
    notes: `${expired ? `Expired ${credential.expiry}. ` : ''}Listed in AMPP's public registry: ${listed}`,
  };
}

export const ampp: Adapter = {
  body: 'ampp',
  searchable: true,
  name: 'AMPP — public credential registry (nace.useclarus.com)',
  issuerUrl: PAGE_URL,
  supports: (i) => !!amppNumber(i.number) || !!amppSurname(i.holder),

  async lookup(i: LookupInput): Promise<LookupResult> {
    const checkedAt = new Date().toISOString();
    const number = amppNumber(i.number);
    const surname = amppSurname(i.holder);
    const filter_expression = [number && `number startswith ${number}`, surname && `last_name startswith ${surname}`].filter(Boolean);
    const res = await httpPost(API_URL, JSON.stringify({ filter_join: 'and', filter_expression, limit: LIMIT + 1 }), {
      accept: 'application/json', 'content-type': 'application/json', referer: PAGE_URL,
    });
    if (!res.ok) return { checkedWhere: PAGE_URL, checkedAt, result: 'not_supported', notes: `AMPP's registry did not answer (${res.error ?? `HTTP ${res.status}`}) — not a verdict.` };
    let rows: AmppRow[] | null = null;
    try { const j = JSON.parse(res.body); rows = Array.isArray(j?.data) ? j.data : null; } catch { rows = null; }
    if (!rows) return { checkedWhere: PAGE_URL, checkedAt, result: 'not_supported', notes: 'AMPP\'s registry answered, but not with {"data": [...]} — the API may have changed; record the new shape in ampp.ts.' };
    if (rows.length > LIMIT) return { checkedWhere: PAGE_URL, checkedAt, result: 'not_supported', notes: `More than ${LIMIT} AMPP listings match; search needs the certification number and surname together.` };
    return readAmpp(rows, i, checkedAt);
  },
};
