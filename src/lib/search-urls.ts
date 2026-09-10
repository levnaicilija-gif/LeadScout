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

/**
 * The trade words a job's own country uses, so a second search finds the people who wrote their
 * profile in their own language. An English-only query misses every Norwegian who calls himself
 * an industrirørlegger rather than a pipefitter.
 *
 * English stays the first query; this is the variant, never a replacement.
 */
const LOCAL_TRADE_WORDS: Record<string, Record<string, string[]>> = {
  NO: { welder: ['sveiser'], pipefitter: ['industrirørlegger', 'rørlegger'], fitter: ['industrimekaniker', 'mekaniker'], scaffolder: ['stillasbygger'], electrician: ['elektriker', 'elektromontør'], painter: ['overflatebehandler', 'industrimaler'], blaster: ['blåser', 'overflatebehandler'], 'wind technician': ['vindtekniker'], ndt: ['ndt-inspektør'] },
  DK: { welder: ['svejser'], pipefitter: ['rørsmed', 'industrirørlægger'], fitter: ['industrimekaniker', 'montør'], scaffolder: ['stilladsarbejder'], electrician: ['elektriker'], painter: ['industrimaler'], blaster: ['sandblæser'], 'wind technician': ['vindmølletekniker'] },
  SE: { welder: ['svetsare'], pipefitter: ['rörmontör'], fitter: ['industrimekaniker', 'montör'], scaffolder: ['ställningsbyggare'], electrician: ['elektriker'], painter: ['industrimålare'], 'wind technician': ['vindkrafttekniker'] },
  NL: { welder: ['lasser'], pipefitter: ['pijpfitter'], fitter: ['monteur', 'servicemonteur'], scaffolder: ['steigerbouwer'], electrician: ['elektromonteur'], painter: ['industrieel schilder'], blaster: ['straler'], 'wind technician': ['windturbine monteur'] },
  DE: { welder: ['schweißer'], pipefitter: ['rohrschlosser'], fitter: ['industriemechaniker', 'monteur'], scaffolder: ['gerüstbauer'], electrician: ['elektroniker', 'elektriker'], painter: ['industrielackierer'], 'wind technician': ['windenergietechniker'] },
  PL: { welder: ['spawacz'], pipefitter: ['monter rurociągów'], fitter: ['ślusarz', 'mechanik'], scaffolder: ['rusztowaniowiec'], electrician: ['elektryk'], painter: ['malarz przemysłowy'], blaster: ['piaskarz'] },
  ES: { welder: ['soldador'], pipefitter: ['tuberero'], fitter: ['mecánico industrial'], scaffolder: ['andamiero'], electrician: ['electricista'], painter: ['pintor industrial'], blaster: ['chorreador'] },
  FR: { welder: ['soudeur'], pipefitter: ['tuyauteur'], fitter: ['mécanicien industriel'], scaffolder: ['échafaudeur'], electrician: ['électricien'], painter: ['peintre industriel'] },
  IT: { welder: ['saldatore'], pipefitter: ['tubista'], fitter: ['meccanico industriale'], scaffolder: ['ponteggiatore'], electrician: ['elettricista'] },
  RO: { welder: ['sudor'], pipefitter: ['lăcătuş montator'], fitter: ['mecanic industrial'], scaffolder: ['schelar'], electrician: ['electrician'], painter: ['vopsitor industrial'], blaster: ['sablator'] },
  PT: { welder: ['soldador'], pipefitter: ['tubista'], fitter: ['mecânico industrial'], scaffolder: ['andaimeiro'], electrician: ['eletricista'] },
};

/** null when we have no words for that country — better no second search than a nonsense one. */
export function xrayLocalVariantUrl(q: { roles: string[]; certs: string[]; countries: string[] }, jobCountry?: string | null): string | null {
  const cc = (jobCountry ?? '').trim().toUpperCase();
  const words = LOCAL_TRADE_WORDS[cc];
  if (!words) return null;
  const local = [...new Set(q.roles.flatMap((r) => words[r.toLowerCase()] ?? []))];
  if (!local.length) return null;
  const or = (a: string[]) => '(' + a.map((s) => (s.includes(' ') ? `"${s}"` : s)).join(' OR ') + ')';
  return `https://www.google.com/search?q=${encodeURIComponent(`site:linkedin.com/in ${or(local)} ${or(q.certs)} ${or([cc, ...q.countries])}`)}`;
}
