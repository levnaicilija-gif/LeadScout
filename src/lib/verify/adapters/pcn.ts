import { chromium } from 'playwright';
import type { Adapter, LookupInput, LookupResult, SourceCertificate } from './types';
import { ukDateToIso } from './types';

/**
 * PCN — BINDT public certificate verification.
 *
 * Confirmed against the live site on 2026-09-08:
 *   URL    https://www.bindt.org/Certification/pcn-certificate-verification/
 *          (the older /Certification/PCN/pcn-certificate-holder-search/ path is a 404)
 *   Form   form.verification-certificate, method=post to the same path
 *   Fields #txtNumber + button #submit1  -> search by PCN number
 *          #txtName   + button #submit2  -> search by last name
 *          hidden input name="Action" value="Search"
 *   Result div.pcn-verification-form-results
 *            dl > dt.name                      holder name
 *                 dd  "PCN number: 123456", "Has N valid certificates"
 *                 tr > td > b "Certificate number:" followed by the number
 *                 tr.certificate-detail           already in the DOM (JS only toggles it)
 *                   td.label "Method:" "Level:" "Sector:" "Scope:" "Issue date:" "Expiry date:" "Issue:"
 *            "No results were found"          when nothing matches
 *   Dates  dd/mm/yyyy
 *   Note   the field accepts the six-digit PCN number only; a certificate number
 *          (e.g. EN0248492OUQ8) returns no results, so we search by number when the
 *          input looks like a PCN number and otherwise fall back to the last name.
 */
const URL = 'https://www.bindt.org/Certification/pcn-certificate-verification/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const isPcnNumber = (s?: string) => !!s && /^\d{4,8}$/.test(s.trim());
const lastName = (holder?: string) => (holder ?? '').trim().split(/\s+/).filter(Boolean).pop();
const norm = (s?: string) => (s ?? '').toLowerCase().replace(/\s+/g, '');

export const pcn: Adapter = {
  body: 'pcn',
  name: 'PCN — BINDT (bindt.org)',
  issuerUrl: URL,
  supports: (i) => isPcnNumber(i.number) || !!lastName(i.holder),

  async lookup(i: LookupInput): Promise<LookupResult> {
    const browser = await chromium.launch();
    const checkedAt = new Date().toISOString();
    try {
      const page = await browser.newPage({ userAgent: UA });
      page.setDefaultTimeout(45000);
      // tsx/esbuild compiles with --keep-names, which rewrites the functions we hand to
      // page.evaluate to call a __name helper that does not exist in the browser. Provide it.
      // Passed as a string so the bundler cannot rewrite it in turn.
      await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || function (f) { return f; };' });
      await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('form.verification-certificate', { timeout: 30000 });

      const byNumber = isPcnNumber(i.number);
      const term = byNumber ? i.number!.trim() : lastName(i.holder)!;
      await page.fill(byNumber ? '#txtNumber' : '#txtName', term);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
        page.click(byNumber ? '#submit1' : '#submit2'),
      ]);
      await page.waitForSelector('.pcn-verification-form-results', { timeout: 30000 });

      const holders = await page.evaluate(() => {
        const box = document.querySelector('.pcn-verification-form-results');
        if (!box) return [] as any[];
        const txt = (e: Element | null) => (e ? (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim() : '');
        return [...box.querySelectorAll('dl')].map((dl) => {
          const body = txt(dl.querySelector('dd'));
          const certs: any[] = [];
          // Each certificate is a "Certificate number:" row followed by its tr.certificate-detail.
          dl.querySelectorAll('tr').forEach((tr) => {
            const b = tr.querySelector('td > b');
            if (!b || !/certificate number/i.test(b.textContent ?? '')) return;
            const number = txt(tr.querySelector('td')).replace(/^certificate number:\s*/i, '').trim();
            const detail = tr.nextElementSibling;
            const fields: Record<string, string> = {};
            if (detail && detail.classList.contains('certificate-detail')) {
              detail.querySelectorAll('td.label').forEach((label) => {
                // Ignore the nested "most recent previous certificate" table.
                if (label.closest('.previous-certs')) return;
                const key = txt(label).replace(/:\s*$/, '').toLowerCase();
                const val = txt(label.nextElementSibling);
                if (key && val) fields[key] = val;
              });
            }
            certs.push({
              number,
              method: fields['method'],
              level: fields['level'],
              sector: fields['sector'],
              scope: fields['scope'],
              issued: fields['issue date'],
              expiry: fields['expiry date'],
            });
          });
          return {
            name: txt(dl.querySelector('dt.name')),
            pcnNumber: (body.match(/PCN number:\s*(\d+)/i) ?? [])[1],
            certs,
          };
        });
      });

      const screenshot = await page.screenshot({ fullPage: true });
      const checkedWhere = page.url();

      if (!holders.length) {
        return {
          result: 'not_found', checkedWhere, checkedAt, screenshot,
          notes: `No PCN record for ${byNumber ? `number ${term}` : `last name "${term}"`}`,
        };
      }

      // Pick the record: by PCN number when we searched that way, else by exact full-name match.
      const wantedName = (i.holder ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      const rec =
        (byNumber ? holders.find((h) => h.pcnNumber === term) : undefined) ??
        (wantedName ? holders.find((h) => h.name.toLowerCase() === wantedName) : undefined) ??
        (holders.length === 1 ? holders[0] : undefined);

      if (!rec) {
        return {
          result: 'not_found', checkedWhere, checkedAt, screenshot,
          notes: `${holders.length} PCN holders share the last name "${term}"; none matched "${i.holder ?? ''}" exactly. Re-check by PCN number.`,
        };
      }

      const certificates: SourceCertificate[] = rec.certs.map((c: any) => ({
        ...c,
        issued: ukDateToIso(c.issued) ?? c.issued,
        expiry: ukDateToIso(c.expiry) ?? c.expiry,
      }));

      // Prefer the exact certificate we hold; fall back to the method printed on it.
      const wantNo = norm(i.number);
      const wantMethod = (i.method ?? '').toLowerCase().trim();
      const match =
        certificates.find((c) => !!wantNo && norm(c.number) === wantNo) ??
        (wantMethod
          ? certificates.find((c) => {
              const m = (c.method ?? '').toLowerCase();
              return !!m && (m.includes(wantMethod) || wantMethod.includes(m));
            })
          : undefined);

      const listed = certificates
        .map((c) => `${c.method ?? '?'} L${c.level ?? '?'} ${c.sector ?? ''} — ${c.number ?? '?'} expires ${c.expiry ?? '?'}`)
        .join(' · ');
      const summary = `PCN number ${rec.pcnNumber ?? '?'} · ${certificates.length} certificate(s) listed · ${listed}`;

      if (!match) {
        // The holder is on the register, but the certificate we hold is not among the valid ones.
        return {
          result: 'not_found', checkedWhere, checkedAt, screenshot, certificates,
          holderOnSource: rec.name,
          notes: `Holder is on the PCN register, but ${i.number ? `certificate ${i.number}` : 'this certificate'} is not among their valid certificates. ${summary}`,
        };
      }

      const today = new Date().toISOString().slice(0, 10);
      const expired = !!match.expiry && match.expiry < today;
      return {
        result: expired ? 'invalid' : 'valid',
        checkedWhere, checkedAt, screenshot, certificates,
        validUntil: match.expiry,
        holderOnSource: rec.name,
        notes: expired ? `Expired ${match.expiry}. ${summary}` : summary,
      };
    } finally {
      await browser.close();
    }
  },
};
