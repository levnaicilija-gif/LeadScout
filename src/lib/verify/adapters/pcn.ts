import * as cheerio from 'cheerio';
import { httpPost } from '@/lib/http';
import type { Adapter, LookupInput, LookupResult, SourceCertificate } from './types';
import { ukDateToIso } from './types';

/**
 * PCN — BINDT public certificate verification. NO BROWSER NEEDED.
 *
 * Confirmed against the live site on 2026-09-08, re-confirmed over plain HTTP 2026-09-09:
 *   URL    https://www.bindt.org/Certification/pcn-certificate-verification/
 *          (the older /Certification/PCN/pcn-certificate-holder-search/ path is a 404)
 *   Form   form.verification-certificate posts urlencoded to the same path:
 *            txtNumber=<pcn number> | txtName=<last name>, Action=Search, submit=submit
 *          A plain POST returns the fully rendered results — no JavaScript involved — so
 *          this runs on any serverless function without a browser.
 *   Result div.pcn-verification-form-results
 *            dl > dt.name                      holder name
 *                 dd  "PCN number: 123456"
 *                 tr > td > b "Certificate number:" followed by the number
 *                 tr.certificate-detail           always present (JS only toggles it)
 *                   td.label "Method:" "Level:" "Sector:" "Scope:" "Issue date:" "Expiry date:"
 *            "No results were found"          when nothing matches
 *   Dates  dd/mm/yyyy
 *   Note   the field takes the six-digit PCN number only; a certificate number
 *          (e.g. EN0248492OUQ8) returns nothing, so we search by number when the input looks
 *          like a PCN number and otherwise fall back to the last name.
 */
const URL_ = 'https://www.bindt.org/Certification/pcn-certificate-verification/';
const isPcnNumber = (s?: string) => !!s && /^\d{4,8}$/.test(s.trim());
const lastName = (holder?: string) => (holder ?? '').trim().split(/\s+/).filter(Boolean).pop();
const norm = (s?: string) => (s ?? '').toLowerCase().replace(/\s+/g, '');

export const pcn: Adapter = {
  body: 'pcn',
  name: 'PCN — BINDT (bindt.org)',
  issuerUrl: URL_,
  supports: (i) => isPcnNumber(i.number) || !!lastName(i.holder),

  async lookup(i: LookupInput): Promise<LookupResult> {
    const checkedAt = new Date().toISOString();
    const byNumber = isPcnNumber(i.number);
    const term = byNumber ? i.number!.trim() : lastName(i.holder)!;

    const res = await httpPost(
      URL_,
      new URLSearchParams({ txtNumber: byNumber ? term : '', txtName: byNumber ? '' : term, Action: 'Search', submit: 'submit' }),
      { 'content-type': 'application/x-www-form-urlencoded', referer: URL_ },
    );
    if (!res.ok) {
      return { result: 'not_supported', checkedWhere: URL_, checkedAt, notes: `BINDT did not respond (${res.error ?? `HTTP ${res.status}`})` };
    }

    const $ = cheerio.load(res.body);
    const box = $('.pcn-verification-form-results');
    if (box.length === 0) {
      return { result: 'not_supported', checkedWhere: URL_, checkedAt, notes: 'BINDT responded but the results block was not in the page — the form may have changed' };
    }

    const txt = (el: any) => $(el).text().replace(/\s+/g, ' ').trim();
    const holders = box.find('dl').toArray().map((dl) => {
      const $dl = $(dl);
      const certs: SourceCertificate[] = [];
      $dl.find('tr').each((_, tr) => {
        const $tr = $(tr);
        const label = $tr.find('td > b').first();
        if (!/certificate number/i.test(label.text())) return;
        const number = txt($tr.find('td').first()).replace(/^certificate number:\s*/i, '').trim();
        const fields: Record<string, string> = {};
        const detail = $tr.next('tr.certificate-detail');
        detail.find('td.label').each((__, td) => {
          if ($(td).closest('.previous-certs').length) return; // ignore the superseded certificate table
          const key = txt(td).replace(/:\s*$/, '').toLowerCase();
          const val = txt($(td).next());
          if (key && val) fields[key] = val;
        });
        certs.push({
          number,
          method: fields['method'], level: fields['level'], sector: fields['sector'], scope: fields['scope'],
          issued: ukDateToIso(fields['issue date']) ?? fields['issue date'],
          expiry: ukDateToIso(fields['expiry date']) ?? fields['expiry date'],
        });
      });
      return { name: txt($dl.find('dt.name').first()), pcnNumber: (txt($dl.find('dd').first()).match(/PCN number:\s*(\d+)/i) ?? [])[1], certs };
    });

    if (holders.length === 0) {
      return { result: 'not_found', checkedWhere: URL_, checkedAt, notes: `No PCN record for ${byNumber ? `number ${term}` : `last name "${term}"`}` };
    }

    const wantedName = (i.holder ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const rec =
      (byNumber ? holders.find((h) => h.pcnNumber === term) : undefined) ??
      (wantedName ? holders.find((h) => h.name.toLowerCase() === wantedName) : undefined) ??
      (holders.length === 1 ? holders[0] : undefined);

    if (!rec) {
      return { result: 'not_found', checkedWhere: URL_, checkedAt, notes: `${holders.length} PCN holders share the last name "${term}"; none matched "${i.holder ?? ''}" exactly. Re-check by PCN number.` };
    }

    const certificates = rec.certs;
    const wantNo = norm(i.number);
    const wantMethod = (i.method ?? '').toLowerCase().trim();
    const match =
      certificates.find((c) => !!wantNo && norm(c.number) === wantNo) ??
      (wantMethod ? certificates.find((c) => { const m = (c.method ?? '').toLowerCase(); return !!m && (m.includes(wantMethod) || wantMethod.includes(m)); }) : undefined);

    const listed = certificates.map((c) => `${c.method ?? '?'} L${c.level ?? '?'} ${c.sector ?? ''} — ${c.number ?? '?'} expires ${c.expiry ?? '?'}`).join(' · ');
    const summary = `PCN number ${rec.pcnNumber ?? '?'} · ${certificates.length} certificate(s) listed · ${listed}`;

    if (!match) {
      return {
        result: 'not_found', checkedWhere: URL_, checkedAt, certificates, holderOnSource: rec.name,
        notes: `Holder is on the PCN register, but ${i.number ? `certificate ${i.number}` : 'this certificate'} is not among their valid certificates. ${summary}`,
      };
    }

    const today = new Date().toISOString().slice(0, 10);
    const expired = !!match.expiry && match.expiry < today;
    return {
      result: expired ? 'invalid' : 'valid',
      checkedWhere: URL_, checkedAt, certificates, validUntil: match.expiry, holderOnSource: rec.name,
      notes: expired ? `Expired ${match.expiry}. ${summary}` : summary,
    };
  },
};
