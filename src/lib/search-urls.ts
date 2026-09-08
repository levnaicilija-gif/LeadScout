/** Honest contact-finding: we build searches, we never store a guessed profile URL. */
export function cleanCompany(name: string) {
  return name.replace(/\s*\([^)]*\)/g, '').replace(/\b(A\/S|ApS|AS|AB|Oy|GmbH|BV|B\.V\.|Ltd|Limited|plc|S\.A\.|SA|NV|SpA|Sp\. z o\.o\.)\b/gi, '').replace(/\s+/g, ' ').trim();
}
export const linkedinSearchUrl = (name: string, company: string) =>
  `https://www.google.com/search?q=${encodeURIComponent(`"${name}" "${cleanCompany(company)}" site:linkedin.com/in`)}`;
export const googleSearchUrl = (name: string, company: string) =>
  `https://www.google.com/search?q=${encodeURIComponent(`"${name}" "${cleanCompany(company)}"`)}`;
export const xrayCandidatesUrl = (q: { roles: string[]; certs: string[]; sectors: string[]; countries: string[] }) => {
  const or = (a: string[]) => '(' + a.map((s) => (s.includes(' ') ? `"${s}"` : s)).join(' OR ') + ')';
  return `https://www.google.com/search?q=${encodeURIComponent(`site:linkedin.com/in ${or(q.roles)} ${or(q.certs)} ${or(q.sectors)} ${or(q.countries)}`)}`;
};
