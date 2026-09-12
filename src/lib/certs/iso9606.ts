/**
 * ISO 9606 welder qualification designations, decoded in code.
 *
 * A welder's certificate is a single line like
 *
 *   EN ISO 9606-1: (138+136) T BW 1.2 FM1 (M+P) s25(12+13) D219.1 PH-L045 ssnb
 *
 * and a recruiter cannot read it. Nothing here asks a model what it means. Every token is
 * looked up in a table taken from the standard, and a token that is not in a table is reported
 * as read-but-not-decoded rather than guessed at — a wrong range of approval is how a welder
 * gets turned away at the gate, and being confidently wrong is worse than being silent.
 *
 * Two kinds of statement come out, and they are kept apart on purpose:
 *
 *   says   — what the code literally means. A lookup. Certain.
 *   range  — what the standard's range-of-approval tables extend it to. Named rule, and the
 *            printed certificate always governs.
 *
 * Where a range rule is not encoded here, `range` is simply absent. It is never filled in.
 */

export type Decoded = {
  standard: string;                 // "ISO 9606-1"
  material: string;                 // what the -1 / -2 part covers
  says: Line[];                     // what the code says, in order
  can: string[];                    // what this welder can do, plain English
  cannot: string[];                 // what it does not cover
  trades: string[];                 // RFBT trades it satisfies
  fits: string[];                   // job shapes it fits
  undecoded: string[];              // tokens read but not in any table
  raw: string;
};

export type Line = { token: string; label: string; says: string; range?: string };

/* ---------------------------------------------------------------- tables */

/** ISO 4063 process numbers, restricted to those that appear on welder certificates. */
const PROCESS: Record<string, { name: string; short: string; consumable: 'wire' | 'rod' | 'electrode' | 'none' }> = {
  '111': { name: 'manual metal arc welding with covered electrode (MMA / stick)', short: 'MMA', consumable: 'electrode' },
  '114': { name: 'self-shielded tubular-cored arc welding (no gas)', short: 'FCAW-S', consumable: 'wire' },
  '121': { name: 'submerged arc welding with one wire', short: 'SAW', consumable: 'wire' },
  '125': { name: 'submerged arc welding with tubular cored electrode', short: 'SAW', consumable: 'wire' },
  '131': { name: 'MIG welding with solid wire (inert gas)', short: 'MIG', consumable: 'wire' },
  '135': { name: 'MAG welding with solid wire (active gas)', short: 'MAG', consumable: 'wire' },
  '136': { name: 'MAG welding with flux-cored wire', short: 'FCAW', consumable: 'wire' },
  '138': { name: 'MAG welding with metal-cored wire', short: 'MCAW', consumable: 'wire' },
  '141': { name: 'TIG welding with solid filler wire or rod', short: 'TIG', consumable: 'rod' },
  '142': { name: 'TIG welding without filler (autogenous)', short: 'TIG', consumable: 'none' },
  '143': { name: 'TIG welding with cored filler', short: 'TIG', consumable: 'rod' },
  '145': { name: 'TIG welding with reducing gas and solid filler', short: 'TIG', consumable: 'rod' },
  '15': { name: 'plasma arc welding', short: 'PAW', consumable: 'rod' },
  '151': { name: 'plasma MIG welding', short: 'PAW', consumable: 'wire' },
  '152': { name: 'powder plasma arc welding', short: 'PAW', consumable: 'none' },
  '153': { name: 'plasma arc welding, transferred arc', short: 'PAW', consumable: 'rod' },
  '311': { name: 'oxy-acetylene gas welding', short: 'gas', consumable: 'rod' },
};

const PRODUCT: Record<string, { says: string; range?: string }> = {
  P: { says: 'plate or sheet', range: 'Plate qualifies pipe over 150 mm diameter welded in a rotated position, and pipe over 500 mm in any position (ISO 9606-1, 6.3).' },
  T: { says: 'tube or pipe', range: 'A pipe test qualifies plate as well (ISO 9606-1, 6.3). Plate work is covered; the reverse is not automatic.' },
};

const WELD: Record<string, { says: string; range?: string }> = {
  BW: { says: 'butt weld — the two parts joined end to end, full penetration', range: 'A butt-weld qualification also covers fillet welds (ISO 9606-1, 6.4). A fillet-weld qualification never covers butt welds.' },
  FW: { says: 'fillet weld — the corner joint between two parts meeting at an angle' },
};

/**
 * ISO/TR 15608 parent metal groups, and the range each qualifies (ISO 9606-1 Table 3).
 * Only the groups a welder certificate in this industry actually carries are encoded.
 */
const MATERIAL_GROUP: Record<string, { says: string; qualifies?: string[]; note?: string }> = {
  '1.1': { says: 'group 1.1 — carbon steel, specified minimum yield up to 275 N/mm²', qualifies: ['1.1', '1.2', '1.4', '11'] },
  '1.2': { says: 'group 1.2 — carbon-manganese steel, specified minimum yield 275–360 N/mm²', qualifies: ['1.1', '1.2', '1.4', '11'] },
  '1.3': { says: 'group 1.3 — normalised fine-grain steel, specified minimum yield above 360 N/mm²', qualifies: ['1.1', '1.2', '1.3', '1.4', '11'] },
  '1.4': { says: 'group 1.4 — weathering steel (improved atmospheric corrosion resistance)', qualifies: ['1.1', '1.2', '1.4'] },
  '2': { says: 'group 2 — thermomechanically treated fine-grain steel', qualifies: ['1', '2', '11'] },
  '3': { says: 'group 3 — quenched and tempered high-strength steel', qualifies: ['1', '2', '3', '11'] },
  '4': { says: 'group 4 — low-vanadium Cr-Mo-(Ni) steel' },
  '5': { says: 'group 5 — Cr-Mo creep-resisting steel, vanadium free' },
  '6': { says: 'group 6 — high-vanadium Cr-Mo-(Ni) steel' },
  '8': { says: 'group 8 — austenitic stainless steel' },
  '8.1': { says: 'group 8.1 — austenitic stainless steel, Cr/Ni ≤ 15/12', qualifies: ['8.1'] },
  '8.2': { says: 'group 8.2 — austenitic stainless steel, Cr/Ni ≤ 20/15', qualifies: ['8.1', '8.2'] },
  '8.3': { says: 'group 8.3 — austenitic stainless steel, Cr/Ni over 20/15', qualifies: ['8.1', '8.2', '8.3'] },
  '10': { says: 'group 10 — duplex stainless steel' },
  '11': { says: 'group 11 — carbon steel with higher carbon content than group 1' },
  '21': { says: 'group 21 — pure aluminium' },
  '22': { says: 'group 22 — non-heat-treatable aluminium alloy' },
  '23': { says: 'group 23 — heat-treatable aluminium alloy' },
  '41': { says: 'group 41 — nickel, commercially pure' },
  '43': { says: 'group 43 — nickel alloy, Ni-Cr-Fe-Mo' },
};

/** ISO 9606-1 filler metal groups. */
const FILLER_GROUP: Record<string, string> = {
  FM1: 'FM1 — consumables for non-alloy and fine-grain steels',
  FM2: 'FM2 — consumables for high-strength steels',
  FM3: 'FM3 — consumables for creep-resisting steels, up to 3.75 % chromium',
  FM4: 'FM4 — consumables for creep-resisting steels, 3.75 % to 12 % chromium',
  FM5: 'FM5 — consumables for stainless and heat-resisting steels',
  FM6: 'FM6 — consumables for nickel and nickel alloys',
  nm: 'no filler metal — welded autogenously',
};

/**
 * Filler type letters. For 111 these are electrode coverings; for the wire processes they are
 * the wire construction. The letters overlap between the two, so the process decides which
 * meaning applies — reading "B" as "basic covering" on a 136 certificate would be wrong.
 */
const FILLER_TYPE_ELECTRODE: Record<string, string> = {
  A: 'A — acid covering',
  B: 'B — basic covering',
  C: 'C — cellulosic covering',
  R: 'R — rutile covering',
  RA: 'RA — rutile-acid covering',
  RB: 'RB — rutile-basic covering',
  RC: 'RC — rutile-cellulosic covering',
  RR: 'RR — thick rutile covering',
  S: 'S — other coverings',
};
const FILLER_TYPE_WIRE: Record<string, string> = {
  S: 'S — solid wire or rod',
  M: 'M — metal-cored wire',
  B: 'B — flux-cored wire, basic',
  R: 'R — flux-cored wire, rutile, slow-freezing slag',
  P: 'P — flux-cored wire, rutile, fast-freezing slag',
  V: 'V — flux-cored wire, rutile or basic/fluoride',
  W: 'W — flux-cored wire, basic/fluoride, slow-freezing slag',
  Y: 'Y — flux-cored wire, basic/fluoride, fast-freezing slag',
  Z: 'Z — flux-cored wire, other types',
};

/**
 * Welding positions (ISO 6947) and what each qualifies (ISO 9606-1 Table 5).
 *
 * The inclined-pipe tests are the ones that matter commercially: H-L045 is what a yard means by
 * "6G", and it is the position that covers everything welded upwards.
 */
const POSITION: Record<string, { says: string; covers?: string[]; coversText?: string }> = {
  PA: { says: 'PA — flat (downhand)', covers: ['PA'] },
  PB: { says: 'PB — horizontal-vertical, the fillet welded on a horizontal surface', covers: ['PA', 'PB'] },
  PC: { says: 'PC — horizontal, welding along a vertical face', covers: ['PA', 'PB', 'PC'] },
  PD: { says: 'PD — horizontal-overhead fillet', covers: ['PA', 'PB', 'PD'] },
  PE: { says: 'PE — overhead', covers: ['PA', 'PB', 'PD', 'PE'] },
  PF: { says: 'PF — vertical, welding upwards', covers: ['PA', 'PB', 'PF'] },
  PG: { says: 'PG — vertical, welding downwards', covers: ['PA', 'PB', 'PG'] },
  PH: { says: 'PH — pipe with its axis horizontal, fixed, welded upwards (what a yard calls 5G up)', covers: ['PA', 'PB', 'PF', 'PH'] },
  PJ: { says: 'PJ — pipe with its axis horizontal, fixed, welded downwards (5G down)', covers: ['PA', 'PB', 'PG', 'PJ'] },
  'H-L045': {
    says: 'H-L045 — pipe fixed at 45°, welded upwards. This is the test a yard means by "6G".',
    covers: ['PA', 'PB', 'PC', 'PD', 'PE', 'PF', 'PH'],
    coversText: 'the hardest upward test there is: it covers every position welded upwards, on plate and on pipe',
  },
  'J-L045': {
    says: 'J-L045 — pipe fixed at 45°, welded downwards ("6G down").',
    covers: ['PA', 'PB', 'PC', 'PD', 'PE', 'PG', 'PJ'],
    coversText: 'every position welded downwards, on plate and on pipe',
  },
};

const SIDE: Record<string, { says: string; range?: string }> = {
  ss: { says: 'ss — welded from one side only', range: 'Welding from one side also qualifies welding from both sides. The reverse does not hold.' },
  bs: { says: 'bs — welded from both sides' },
};
const BACKING: Record<string, { says: string; range?: string }> = {
  nb: { says: 'nb — no backing: the root was welded open, with nothing behind it', range: 'Welding with no backing also qualifies welding with backing. The reverse does not hold.' },
  mb: { says: 'mb — welded onto a material backing strip' },
  gb: { says: 'gb — welded with gas backing (purged root)' },
};
const LAYERS: Record<string, { says: string }> = {
  sl: { says: 'sl — single layer' },
  ml: { says: 'ml — multi layer' },
};


/* ---------------------------------------------------------------- parsing */

const num = (s: string) => Number(String(s).replace(',', '.'));
const round = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ''));
/** A minimum is rounded up, never down: rounding 109.55 to 109.5 says he may weld pipe he may not. */
const roundUp = (n: number) => round(Math.ceil(n * 10) / 10);

/** ISO 9606-1 Table 7 — range of qualification for thickness, in mm. */
function thicknessRange(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return '';
  if (t < 3) return `${round(t)} mm to ${round(2 * t)} mm`;
  if (t <= 12) return `3 mm to ${round(2 * t)} mm`;
  return '5 mm and above, with no upper limit';
}

/** ISO 9606-1 — range of qualification for pipe outside diameter, in mm. */
function diameterRange(d: number): string {
  if (!Number.isFinite(d) || d <= 0) return '';
  if (d <= 25) return `${round(d)} mm to ${round(2 * d)} mm outside diameter`;
  return `${roundUp(0.5 * d)} mm outside diameter and above (the ≥ 0.5 D rule), and plate`;
}

function standardOf(raw: string): { standard: string; material: string } {
  const m = raw.match(/9606\s*[-–]\s*(\d)/);
  const part = m?.[1] ?? '1';
  const by: Record<string, string> = {
    '1': 'steels',
    '2': 'aluminium and aluminium alloys',
    '3': 'copper and copper alloys',
    '4': 'nickel and nickel alloys',
    '5': 'titanium, zirconium and their alloys',
  };
  return { standard: `ISO 9606-${part}`, material: by[part] ?? 'steels' };
}

/** What the parse found, before any of it is turned into prose. */
type Facts = {
  processes: string[];
  product?: 'P' | 'T';
  weld?: 'BW' | 'FW';
  group?: string;
  fillerGroup?: string;
  letters: string[];
  thickness?: { kind: 't' | 's'; total: number; split: number[] };
  diameter?: number;
  positions: string[];
  side?: 'ss' | 'bs';
  backing?: 'nb' | 'mb' | 'gb';
  layers?: 'ml' | 'sl';
};

/**
 * Decode a designation. Everything not recognised is listed in `undecoded`, so a card can say
 * "this part of the code was read but is not explained here" instead of quietly dropping it.
 */
export function decodeIso9606(raw0: string, extra?: { position?: string | null; process?: string | null }): Decoded | null {
  const raw = [raw0, extra?.position, extra?.process].filter(Boolean).join(' ');
  if (!/9606/i.test(raw) && !/\b(1[13][1-9]|111|114|121|125|141|142|143|145)\b/.test(raw)) return null;

  const { standard, material } = standardOf(raw);
  const undecoded: string[] = [];
  const f: Facts = { processes: [], letters: [], positions: [] };

  const body = raw.replace(/\b(EN\s*)?ISO\s*9606\s*[-–]\s*\d\s*:?/gi, ' ').replace(/\bEN\b/gi, ' ');
  // Tokens, with brackets and joiners treated as separators — "(138+136)" is two tokens, and
  // "(M+P)" is two letters, which the old single-separator scan silently lost the second of.
  const tokens = body.split(/[\s,;()+/]+/).map((t) => t.trim()).filter(Boolean);

  for (const p of tokens) if (PROCESS[p] && !f.processes.includes(p)) f.processes.push(p);
  f.product = tokens.find((t) => /^[PT]$/.test(t)) as any;
  f.weld = tokens.find((t) => /^(BW|FW)$/i.test(t))?.toUpperCase() as any;

  const group = tokens.find((t) => /^(1|2|3|4|5|6|7|8|10|11|21|22|23|41|43)(\.\d)?$/.test(t) && MATERIAL_GROUP[t]);
  if (group) f.group = group;

  const fm = tokens.find((t) => /^FM[1-6]$/i.test(t));
  if (fm) f.fillerGroup = fm.toUpperCase();
  else if (tokens.some((t) => /^nm$/i.test(t))) f.fillerGroup = 'nm';

  // The consumable letters stand alone as tokens once brackets and "+" are separators.
  for (const t of tokens) {
    if (/^(R[ABCR]|[ABCMPRSVWYZ])$/.test(t) && !f.letters.includes(t)) f.letters.push(t);
  }

  const th = body.match(/\b([ts])\s?(\d+(?:[.,]\d+)?)\s*(?:\(([^)]*)\))?/i);
  if (th) {
    f.thickness = {
      kind: th[1].toLowerCase() as 't' | 's',
      total: num(th[2]),
      split: (th[3] ?? '').split(/[+/]/).map(num).filter((n) => Number.isFinite(n) && n > 0),
    };
    // "s12/13" writes the split without brackets.
    if (!f.thickness.split.length) {
      const slash = body.match(/\b[ts]\s?\d+(?:[.,]\d+)?\s*\/\s*(\d+(?:[.,]\d+)?)/i);
      if (slash) f.thickness.split = [f.thickness.total, num(slash[1])];
    }
  }

  const dia = body.match(/\bD\s?(\d+(?:[.,]\d+)?)/i);
  if (dia) f.diameter = num(dia[1]);

  for (const m of body.matchAll(/\b(P?[HJ]-?L\s?045|P[ABCDEFGHJ])\b/gi)) {
    const t = m[1].toUpperCase().replace(/\s/g, '').replace(/^P([HJ])-?L045$/, '$1-L045').replace(/^([HJ])L045$/, '$1-L045');
    if (!f.positions.includes(t)) f.positions.push(t);
  }

  // Side, backing and layers arrive spaced ("ss nb ml") or run together ("ssnb"). Matched as
  // whole tokens only: scanning the flattened string read the "b" of "M/B s12" as "bs".
  for (const t of tokens) {
    const m = t.toLowerCase().match(/^(ss|bs)?(nb|mb|gb)?(ml|sl)?$/);
    if (!m || !(m[1] || m[2] || m[3])) continue;
    if (m[1]) f.side = m[1] as any;
    if (m[2]) f.backing = m[2] as any;
    if (m[3]) f.layers = m[3] as any;
  }

  const says = linesFrom(f, undecoded);
  if (!says.length) return null;
  return { standard, material, says, ...plainEnglish(standard, f), undecoded, raw: raw0.trim() };
}

/** The facts, in the order they appear in the designation, each with its lookup and its rule. */
function linesFrom(f: Facts, undecoded: string[]): Line[] {
  const out: Line[] = [];
  const push = (token: string, label: string, says: string, range?: string) => out.push({ token, label, says, range });

  for (const p of f.processes) {
    push(p, 'Process', `${p} — ${PROCESS[p].name}`, 'A welder is qualified for the process tested and no other. A MAG ticket is not a TIG ticket.');
  }
  if (f.product) push(f.product, 'Product', PRODUCT[f.product].says, PRODUCT[f.product].range);
  if (f.weld) push(f.weld, 'Weld type', WELD[f.weld].says, WELD[f.weld].range);
  if (f.group) {
    const g = MATERIAL_GROUP[f.group];
    push(f.group, 'Parent metal', g.says, g.qualifies ? `Qualifies parent metal groups ${g.qualifies.join(', ')} (ISO 9606-1 Table 3).` : undefined);
  }
  if (f.fillerGroup) push(f.fillerGroup, 'Filler metal', FILLER_GROUP[f.fillerGroup] ?? f.fillerGroup);

  // Only 111 carries a covering; every other process on these certificates carries a wire or a
  // rod, and reading "S" from the covering table there gave "other coverings" for plain TIG.
  const covered = f.processes.length > 0 && f.processes.every((p) => PROCESS[p].consumable === 'electrode');
  const table = covered ? FILLER_TYPE_ELECTRODE : FILLER_TYPE_WIRE;
  for (const L of f.letters) {
    if (!table[L]) { undecoded.push(L); continue; }
    push(L, 'Consumable', table[L]);
  }

  if (f.thickness) {
    const { kind, total, split } = f.thickness;
    const perProcess = split.length > 1 && split.length === f.processes.length
      ? split.map((s, i) => `${f.processes[i]}: ${round(s)} mm deposited, covering ${thicknessRange(s)}`).join(' · ')
      : '';
    push(
      `${kind}${round(total)}${split.length > 1 ? `(${split.map(round).join('+')})` : ''}`,
      'Thickness',
      kind === 's'
        ? `${round(total)} mm of weld metal deposited in the test${split.length > 1 ? ` (${split.map(round).join(' + ')} mm)` : ''}`
        : `${round(total)} mm material thickness in the test`,
      perProcess
        ? `Each process is qualified on its own deposit (ISO 9606-1 Table 7) — ${perProcess}.`
        : `Qualifies ${thicknessRange(total)} (ISO 9606-1 Table 7).`,
    );
  }
  if (f.diameter) push(`D${round(f.diameter)}`, 'Diameter', `tested on ${round(f.diameter)} mm outside diameter pipe`, `Qualifies ${diameterRange(f.diameter)}.`);

  for (const t of f.positions) {
    const p = POSITION[t];
    if (!p) { undecoded.push(t); continue; }
    push(t, 'Position', p.says, p.covers ? `Covers ${p.covers.join(', ')} (ISO 9606-1 Table 5).` : undefined);
  }
  if (f.side) push(f.side, 'Sides', SIDE[f.side].says, SIDE[f.side].range);
  if (f.backing) push(f.backing, 'Backing', BACKING[f.backing].says, BACKING[f.backing].range);
  if (f.layers) push(f.layers, 'Layers', LAYERS[f.layers].says);
  return out;
}

/* ------------------------------------------------- the three plain layers */

/**
 * The same facts said again for someone who does not read the code.
 *
 * Written from the parsed values, not by cutting up the sentences above: a plain-English line
 * assembled with a regex over another sentence is how you end up telling a client the welder
 * qualifies "3 mm to 24 mm ." with the rule silently amputated.
 */
function plainEnglish(standard: string, f: Facts) {
  const can: string[] = [];
  const cannot: string[] = [];
  const fits: string[] = [];
  const trades = new Set<string>();

  const sixG = f.positions.includes('H-L045');
  const sixGDown = f.positions.includes('J-L045');
  const fiveG = f.positions.includes('PH') || sixG;
  const pipe = f.product === 'T' || f.diameter !== undefined;
  const butt = f.weld === 'BW';
  const carbon = !!f.group?.startsWith('1') || f.group === '2' || f.group === '3' || f.group === '11';

  if (f.processes.length) {
    trades.add('welder');
    const names = f.processes.map((p) => `${PROCESS[p].short} (${p})`);
    can.push(`Welds with ${names.join(' and ')}${names.length > 1 ? ', both on this one certificate' : ''}.`);
  }
  if (butt && pipe) can.push('Butt welds on pipe. That covers plate as well, and covers fillet welds.');
  else if (butt) can.push('Butt welds, which also covers fillet welds.');
  else if (f.weld === 'FW') can.push('Fillet welds only.');

  if (sixG) can.push('Works in 6G — pipe fixed at 45° and welded upwards, the hardest of the standard position tests. Every upward position is covered, so no site position should be refused on this ticket.');
  else if (sixGDown) can.push('Works in 6G down — pipe fixed at 45° and welded downwards; every downward position is covered.');
  else if (fiveG) can.push('Works in 5G — pipe fixed horizontally and welded upwards.');
  else if (f.positions.length) can.push(`Works in ${f.positions.join(', ')}${POSITION[f.positions[0]]?.covers ? `, which covers ${POSITION[f.positions[0]].covers!.join(', ')}` : ''}.`);

  if (f.thickness) {
    const { total, split } = f.thickness;
    if (split.length > 1 && split.length === f.processes.length) {
      can.push(`Thickness: each process on its own deposit — ${split.map((s, i) => `${f.processes[i]} from ${thicknessRange(s)}`).join(', ')}.`);
    } else {
      can.push(`Thickness: ${thicknessRange(total)}.`);
    }
  }
  if (f.diameter) can.push(`Pipe size: ${diameterRange(f.diameter)}.`);
  if (f.group) {
    const g = MATERIAL_GROUP[f.group];
    can.push(`Parent metal: ${g.says.replace(/^group [\d.]+ — /, '')}${g.qualifies ? `, and also groups ${g.qualifies.join(', ')}` : ''}.`);
  }
  if (f.side === 'ss' && f.backing === 'nb') can.push('Welded from one side with no backing — an open root, which is the demanding case and covers welding with backing.');

  // --- what it does not cover. Every line follows from the code, never from a hunch.
  const common = ['111', '135', '136', '138', '141', '121'];
  const missing = common.filter((p) => !f.processes.includes(p));
  if (f.processes.length && missing.length) {
    const names = [...new Set(missing.map((p) => `${PROCESS[p].short} (${p})`))];
    cannot.push(`Other welding processes — ${names.join(', ')}. A welder is qualified for the process tested and no other.`);
  }
  if (/9606-1/.test(standard)) {
    if (carbon || !f.group) cannot.push(`Stainless and duplex${f.group ? '' : ' unless the certificate itself names a group 8 or 10 parent metal'} — that needs a group 8 or 10 qualification.`);
    cannot.push('Aluminium — that is ISO 9606-2, a separate certificate.');
  }
  if (f.positions.length && !f.positions.some((p) => p === 'J-L045' || p === 'PJ' || p === 'PG')) {
    cannot.push('Downward (vertical-down) welding — every position on this certificate is welded upwards.');
  }
  if (f.weld === 'FW') cannot.push('Butt welds — a fillet-weld qualification never covers them.');
  if (f.product === 'P' && !f.diameter) cannot.push('Small-bore pipe — this was a plate test, and plate only qualifies pipe above 150 mm welded rotated.');
  cannot.push('Anything but welding: it says nothing about NDT, coating, rigging or supervision.');

  // --- what it fits, in our terms.
  if (sixG && pipe) fits.push('6G pipe welding — offshore spools, risers, process piping');
  if (pipe) fits.push('pipe welding and pipefitting on fabrication, tie-in and shutdown scopes');
  if (carbon) fits.push('thick-wall carbon steel — jackets, monopiles, transition pieces, structural fabrication');
  if (f.thickness && thicknessRange(f.thickness.split.length ? Math.max(...f.thickness.split) : f.thickness.total).includes('no upper limit')) {
    fits.push('heavy plate and heavy wall — no upper thickness limit on this ticket');
  }
  if (f.processes.includes('136') || f.processes.includes('138')) fits.push('yard and site production welding, where cored-wire MAG is the normal process');
  if (f.processes.includes('141')) fits.push('root runs, and stainless or alloy work where TIG is specified');
  if (f.processes.includes('111')) fits.push('site and repair work where stick is still the practical process');

  return { can, cannot, trades: [...trades], fits };
}

/** Does this text look like an ISO 9606 designation at all? */
export const looksLikeIso9606 = (s?: string | null) => !!s && /9606/i.test(s);
