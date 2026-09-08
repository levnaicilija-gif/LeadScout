/**
 * Renders the client CV to a real file and runs both PII gates over the same text the
 * client would see — once on clean anonymised data, once on data with a name and an
 * employer left in, which must be blocked.
 *   npx tsx --env-file=.env.local scripts/pdf-check.ts
 */
import fs from 'fs';
import { renderClientCv, clientCvText, clientCvAllowed, type ClientCvData } from '../src/lib/pdf/render';
import { piiRegexHits, piiModelReview } from '../src/lib/ai/documents';

const clean: ClientCvData = {
  referenceCode: 'RFBT-P-0231',
  trade: 'Industrial painter / blaster',
  preparedOn: new Date().toISOString(),
  bullets: [
    'FROSIO Level II, verified 7 Sep 2026, valid to March 2028 — no re-qualification needed for a 12-month project.',
    'Coated offshore substations in Spain (2025–26) and monopiles in Denmark (2024): airless spray and Sa 2.5 blasting.',
    'Available 4 October, EU passport, has worked 2:2 and 8:2 rotations without a missed rotation.',
  ],
  certificates: [
    { name: 'FROSIO Level II', number: '12 8471', checkedWhere: 'https://frosio.no/en/', checkedAt: '2026-09-07', validUntil: '2028-03-14', result: 'valid' },
    { name: 'PCN Level 2', number: 'EDY246252V71A', checkedWhere: 'https://www.bindt.org/Certification/pcn-certificate-verification/', checkedAt: '2026-09-08', validUntil: '2029-03-21', result: 'valid' },
    { name: 'ISO 9606', number: 'W-9912', checkedWhere: null, checkedAt: '2026-09-05', validUntil: null, result: 'pending' },
  ],
  experience: [
    { years: '2025–26', what: 'Offshore substations — painting & blasting, Spain', rotation: '8:2' },
    { years: '2024', what: 'Monopile coating, Denmark', rotation: '2:2' },
    { years: '2022–23', what: 'Industrial steel structures, Serbia', rotation: null },
  ],
  skills: ['Airless spray', 'Grit blasting to Sa 2.5', 'DFT/WFT control', 'Confined space', 'Dew-point discipline'],
  languages: ['Serbian (native)', 'English (working)'],
  availability: 'From 4 October 2026 · EU passport · 2:2 or 8:2',
  publicUrl: 'leadscout-rfbt.vercel.app/v/rfbt-p-0231',
  agencyLine: 'RFBT Recruitment · London · Beograd',
};

const allowedOf = clientCvAllowed;

const textOf = clientCvText;

(async () => {
  const pdf = await renderClientCv(clean);
  fs.writeFileSync('client-cv-sample.pdf', pdf);
  console.log(`rendered client-cv-sample.pdf — ${pdf.length} bytes, starts with ${pdf.subarray(0, 5).toString()}`);

  console.log('\n--- clean data');
  const cleanText = textOf(clean);
  console.log('  regex hits :', piiRegexHits(cleanText, 'Marko Jovanović', ['Dragados']).join(', ') || 'none');
  const r1 = await piiModelReview(cleanText, allowedOf(clean));
  console.log('  model      :', r1.clean ? 'clean' : r1.findings.map((f) => `${f.kind}: "${f.text}"`).join(' | '));

  console.log('\n--- leaked data (name + employer + phone left in, must be caught)');
  const leaked: ClientCvData = {
    ...clean,
    bullets: ['Marko Jovanović is available from October; reach him on +381 64 123 4567.', ...clean.bullets.slice(1)],
    experience: [{ years: '2025–26', what: 'Offshore substations for Dragados Offshore, Spain', rotation: '8:2' }, ...clean.experience.slice(1)],
  };
  const leakedText = textOf(leaked);
  console.log('  regex hits :', piiRegexHits(leakedText, 'Marko Jovanović', ['Dragados Offshore']).join(', ') || 'none');
  const r2 = await piiModelReview(leakedText, allowedOf(leaked));
  console.log('  model      :', r2.clean ? 'CLEAN (missed it)' : r2.findings.map((f) => `${f.kind}: "${f.text}"`).join(' | '));
})();
