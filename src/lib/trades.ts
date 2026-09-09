/**
 * Trade inference from a scope of work.
 *
 * The last run scored Vallourec (OCTG supply to Aramco) and ROSEN (pipeline integrity) at 20
 * with an empty trades list, because the model only tagged trades when an article said
 * "welder". Supply-and-service scopes are exactly where RFBT's people work: line pipe and OCTG
 * mean welding, coating and NDT; pipeline integrity means NDT technicians; cable and
 * fabrication scopes mean fitters and blasters. This maps scope language to trades so the
 * inference does not depend on the article using the word.
 */
export const RFBT_TRADE_LIST = ['welder', 'painter', 'blaster', 'pipefitter', 'fitter', 'ndt', 'rope access', 'wind technician', 'electrician', 'scaffolder'] as const;
export type Trade = (typeof RFBT_TRADE_LIST)[number];

const SCOPE_RULES: { match: RegExp; trades: Trade[]; why: string }[] = [
  { match: /\b(line ?pipe|octg|tubular|casing|drill pipe|pipe mill|seamless pipe|welded pipe)\b/i, trades: ['welder', 'ndt', 'blaster', 'painter'], why: 'pipe supply: welded, coated and inspected' },
  { match: /\b(pipeline|pipelay|pipe-lay|subsea pipeline|flowline|riser|spool)\b/i, trades: ['welder', 'pipefitter', 'ndt', 'blaster', 'painter'], why: 'pipeline work' },
  { match: /\b(integrity (assessment|service|management)|inspection (service|campaign|programme)|in-line inspection|nipa|corrosion (survey|assessment))\b/i, trades: ['ndt', 'rope access'], why: 'integrity/inspection scope' },
  { match: /\b(cable (lay|installation|monitoring|pull|termination)|array cable|export cable|umbilical)\b/i, trades: ['electrician', 'ndt', 'rope access'], why: 'cable scope' },
  { match: /\b(monopile|jacket|transition piece|foundation|substructure|topside|substation)\b/i, trades: ['welder', 'blaster', 'painter', 'fitter', 'ndt', 'scaffolder'], why: 'offshore structure fabrication' },
  { match: /\b(fabricat|steel structure|module (build|yard)|newbuild|hull|block assembly|shipyard|yard scope)\b/i, trades: ['welder', 'fitter', 'blaster', 'painter', 'ndt', 'scaffolder'], why: 'fabrication scope' },
  { match: /\b(coating|painting|blasting|surface treatment|galvanis|metallis)\b/i, trades: ['painter', 'blaster'], why: 'surface treatment scope' },
  { match: /\b(epc|epci|epcic|turnkey|engineering, procurement)\b/i, trades: ['welder', 'pipefitter', 'fitter', 'ndt', 'painter', 'blaster', 'scaffolder', 'electrician'], why: 'EPC scope covers the full trade mix' },
  { match: /\b(o&m|operations and maintenance|service (contract|agreement)|maintenance contract|turnaround|shutdown)\b/i, trades: ['wind technician', 'electrician', 'rope access', 'fitter'], why: 'maintenance scope' },
  { match: /\b(blade (repair|inspection|service)|rotor|nacelle|turbine (install|service|maintenance))\b/i, trades: ['wind technician', 'rope access', 'electrician'], why: 'turbine scope' },
  { match: /\b(scaffold|access (solution|package)|rope access)\b/i, trades: ['scaffolder', 'rope access'], why: 'access scope' },
  { match: /\b(lng|refinery|petrochemical|process plant|terminal|storage tank)\b/i, trades: ['welder', 'pipefitter', 'ndt', 'blaster', 'painter', 'scaffolder'], why: 'process plant scope' },
  { match: /\b(drilling (rig|programme|campaign)|jack-?up|semi-?submersible|well (intervention|services))\b/i, trades: ['welder', 'fitter', 'electrician', 'ndt'], why: 'drilling scope' },
];

/**
 * Trades implied by a scope, merged with whatever the model already inferred.
 * Returns the merged list plus the reasons, so a lead can show why it was tagged.
 */
export function inferTrades(modelTrades: string[], ...scopeText: (string | undefined | null)[]) {
  const text = scopeText.filter(Boolean).join(' \n ');
  const found = new Set<string>();
  const why: string[] = [];

  for (const t of modelTrades ?? []) {
    const hit = RFBT_TRADE_LIST.find((r) => t.toLowerCase().includes(r));
    if (hit) found.add(hit);
  }
  for (const rule of SCOPE_RULES) {
    if (!rule.match.test(text)) continue;
    rule.trades.forEach((t) => found.add(t));
    why.push(rule.why);
  }
  return { trades: [...found], why };
}

/** Does this scope employ RFBT trades at all? Used by the fit score. */
export const hasRfbtTrades = (trades: string[]) => trades.some((t) => RFBT_TRADE_LIST.some((r) => t.toLowerCase().includes(r)));
