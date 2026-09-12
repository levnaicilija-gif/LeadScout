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
  return `${round(0.5 * d)} mm outside diameter and above (the ≥ 0.5 D rule), and plate`;
}

/** Which part of ISO 9606 this is, and therefore which metals it can be about at all. */
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

/**
 * Decode a designation. Everything not recognised is listed in `undecoded`, so a card can say
 * "this part of the code was read but is not explained here" instead of quietly dropping it.
 */
export function decodeIso9606(raw0: string, extra?: { position?: string | null; process?: string | null }): Decoded | null {
  const raw = [raw0, extra?.position, extra?.process].filter(Boolean).join(' ');
  if (!/9606/i.test(raw) && !/\b(1[13][1-9]|111|114|121|125|141|142|143|145)\b/.test(raw)) return null;

  const { standard, material } = standardOf(raw);
  const says: Line[] = [];
  const undecoded: string[] = [];
  const seen = new Set<string>();

  // Strip the standard itself, then work token by token on what is left.
  const body = raw.replace(/\b(EN\s*)?ISO\s*9606\s*[-–]\s*\d\s*:?/gi, ' ').replace(/\bEN\b/gi, ' ');
  const tokens = body.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);

  // --- processes. Several may appear: "(138+136)", "138/136", "138 + 136".
  const processes = [...new Set((body.match(/\b(1[0-9]{2}|15[0-3]|15|311)\b/g) ?? []).filter((p) => PROCESS[p]))];
  for (const p of processes) {
    const d = PROCESS[p];
    says.push({
      token: p,
      label: 'Process',
      says: `${p} — ${d.name}`,
      range: 'A welder is qualified for the process tested and no other. A MAG ticket is not a TIG ticket.',
    });
  }

  // --- product form, weld type
  const prod = tokens.find((t) => /^[PT]$/.test(t));
  if (prod) says.push({ token: prod, label: 'Product', says: PRODUCT[prod].says, range: PRODUCT[prod].range });
  const weld = tokens.find((t) => /^(BW|FW)$/i.test(t))?.toUpperCase();
  if (weld) says.push({ token: weld, label: 'Weld type', says: WELD[weld].says, range: WELD[weld].range });

  // --- parent material group. Bare "1.2" or "8.1"; guard against eating a diameter.
  const group = body.match(/(?:^|[\s(])((?:1|2|3|4|5|6|7|8|10|11|21|22|23|41|43)(?:\.\d)?)(?=[\s)]|$)/);
  const gk = group?.[1];
  if (gk && MATERIAL_GROUP[gk]) {
    const g = MATERIAL_GROUP[gk];
    says.push({
      token: gk,
      label: 'Parent metal',
      says: g.says,
      range: g.qualifies ? `Qualifies parent metal groups ${g.qualifies.join(', ')} (ISO 9606-1 Table 3).` : undefined,
    });
    seen.add(gk);
  }

  // --- filler metal group and type letters
  const fm = body.match(/\bFM\s?([1-6])\b/i);
  if (fm) says.push({ token: `FM${fm[1]}`, label: 'Filler metal', says: FILLER_GROUP[`FM${fm[1]}`] });
  else if (/\bnm\b/i.test(body)) says.push({ token: 'nm', label: 'Filler metal', says: FILLER_GROUP.nm });

  const wireProcess = processes.some((p) => PROCESS[p].consumable === 'wire');
  const typeTable = wireProcess ? FILLER_TYPE_WIRE : FILLER_TYPE_ELECTRODE;
  // Only inside a bracket or standing alone — never a stray letter from another token.
  const letters = [...new Set((body.match(/(?:\(|\s)([ABCMPRSVWYZ]|R[ABCR])(?=[\s)+/]|$)/g) ?? []).map((s) => s.replace(/[^A-Z]/g, '')))];
  for (const L of letters) {
    if (!typeTable[L]) { undecoded.push(L); continue; }
    says.push({ token: L, label: 'Consumable', says: typeTable[L] });
  }

  // --- thickness. "t10", "s12", "s25(12+13)" — the bracket splits it per process.
  const th = body.match(/\b([ts])\s?(\d+(?:[.,]\d+)?)\s*(\(([^)]*)\))?/i);
  if (th) {
    const total = num(th[2]);
    const split = th[4]?.split(/[+/]/).map((x) => num(x)).filter((n) => Number.isFinite(n) && n > 0) ?? [];
    const isDeposit = th[1].toLowerCase() === 's';
    const each = split.length && split.length === processes.length
      ? split.map((s, i) => `${processes[i]}: ${round(s)} mm deposited, covering ${thicknessRange(s)}`).join(' · ')
      : '';
    says.push({
      token: `${th[1]}${th[2]}${th[3] ?? ''}`,
      label: 'Thickness',
      says: isDeposit
        ? `${round(total)} mm of weld metal deposited in the test${split.length ? ` (${split.map(round).join(' + ')} mm)` : ''}`
        : `${round(total)} mm material thickness in the test`,
      range: each
        ? `Each process is qualified on its own deposit (ISO 9606-1 Table 7) — ${each}.`
        : `Qualifies ${thicknessRange(total)} (ISO 9606-1 Table 7).`,
    });
  }

  // --- pipe diameter
  const dia = body.match(/\bD\s?(\d+(?:[.,]\d+)?)/i);
  if (dia) {
    const d = num(dia[1]);
    says.push({
      token: `D${dia[1]}`,
      label: 'Diameter',
      says: `tested on ${round(d)} mm outside diameter pipe`,
      range: `Qualifies ${diameterRange(d)}.`,
    });
  }

  // --- positions. "PH-L045" is how some issuers print H-L045; read both halves.
  const posTokens: string[] = [];
  for (const m of body.matchAll(/\b(P?[HJ]-?L\s?045|P[ABCDEFGHJ])\b/gi)) {
    const t = m[1].toUpperCase().replace(/\s/g, '').replace(/^P([HJ])-?L045$/, '$1-L045').replace(/^([HJ])L045$/, '$1-L045');
    if (!posTokens.includes(t)) posTokens.push(t);
  }
  for (const t of posTokens) {
    const p = POSITION[t];
    if (!p) { undecoded.push(t); continue; }
    says.push({
      token: t,
      label: 'Position',
      says: p.says,
      range: p.covers ? `Covers ${p.covers.join(', ')} (ISO 9606-1 Table 5).` : undefined,
    });
  }

  // --- side, backing, layers. "ssnb" arrives unspaced on plenty of certificates.
  const flat = body.replace(/\s+/g, '').toLowerCase();
  for (const [k, v] of Object.entries(SIDE)) if (new RegExp(`(?:^|[^a-z])${k}(?![a-z])|${k}(?=nb|mb|gb)`).test(flat)) says.push({ token: k, label: 'Sides', says: v.says, range: v.range });
  for (const [k, v] of Object.entries(BACKING)) if (new RegExp(`${k}(?![a-z])`).test(flat)) says.push({ token: k, label: 'Backing', says: v.says, range: v.range });
  for (const [k, v] of Object.entries(LAYERS)) if (new RegExp(`(?:^|[^a-z])${k}(?![a-z])`).test(flat)) says.push({ token: k, label: 'Layers', says: v.says });

  if (!says.length) return null;

  return { standard, material, says, ...plainEnglish(standard, material, says, processes, posTokens), undecoded, raw: raw0.trim() };
}

/* ------------------------------------------------- the three plain layers */

function plainEnglish(standard: string, material: string, says: Line[], processes: string[], positions: string[]) {
  const has = (label: string) => says.filter((l) => l.label === label);
  const can: string[] = [];
  const cannot: string[] = [];
  const trades = new Set<string>();
  const fits: string[] = [];

  const procNames = processes.map((p) => `${PROCESS[p].short} (${p})`);
  const sixG = positions.includes('H-L045');
  const fiveG = positions.includes('PH') || sixG;
  const pipe = has('Diameter').length > 0 || has('Product').some((l) => l.token === 'T');
  const butt = has('Weld type').some((l) => l.token === 'BW');
  const thick = has('Thickness')[0];
  const dia = has('Diameter')[0];
  const grp = has('Parent metal')[0];

  if (procNames.length) {
    can.push(`Welds with ${procNames.join(' and ')}${procNames.length > 1 ? ' — both processes are on the same certificate' : ''}.`);
    trades.add('welder');
  }
  if (pipe && butt) can.push('Butt welds on pipe, which also covers plate and covers fillet welds.');
  else if (butt) can.push('Butt welds, which also covers fillet welds.');
  if (sixG) can.push('Works in the 6G position — pipe fixed at 45° and welded upwards, the hardest of the standard tests. Every upward position is covered, so no site position should be refused on the ticket.');
  else if (fiveG) can.push('Works in 5G — pipe fixed horizontally and welded upwards.');
  if (thick?.range) can.push(`Thickness: ${thick.range.replace(/\(ISO[^)]*\)\.?/, '').replace(/^Qualifies /, 'qualifies ').trim()}`);
  if (dia?.range) can.push(`Pipe size: ${dia.range.replace(/\(the[^)]*\)/, '').replace(/^Qualifies /, 'qualifies ').trim()}`);
  if (grp) can.push(`Parent metal: ${grp.says.replace(/^group [\d.]+ — /, '')}${grp.range ? ` — ${grp.range.replace(/^Qualifies /, 'and also qualifies ').replace(/\(ISO[^)]*\)\.?/, '').trim()}` : ''}`);

  // What it does not cover. Only statements that follow from the code, never from a hunch.
  const allProcesses = ['111', '135', '136', '138', '141', '121'];
  const missing = allProcesses.filter((p) => !processes.includes(p));
  if (missing.length) cannot.push(`Other welding processes — ${missing.map((p) => `${PROCESS[p].short} (${p})`).filter((v, i, a) => a.indexOf(v) === i).join(', ')}. A welder is qualified for the process tested and no other.`);
  if (/9606-1/.test(standard)) {
    const gk = grp?.token ?? '';
    if (!gk.startsWith('8') && gk !== '10') cannot.push('Stainless steel and duplex — this certificate is on carbon steel groups. Stainless work needs a group 8 or 10 qualification.');
    cannot.push('Aluminium — that is ISO 9606-2, a separate certificate.');
  }
  if (positions.length && !positions.some((p) => p === 'J-L045' || p === 'PJ' || p === 'PG')) {
    cannot.push('Downward (vertical-down) welding — the positions on this certificate are all welded upwards.');
  }
  if (!butt) cannot.push('Butt welds — a fillet-weld qualification never covers them.');
  cannot.push('It is a welder qualification, not an inspection one: it says nothing about NDT, coating or supervision.');

  // What it fits, in our terms.
  if (sixG && pipe) fits.push('6G pipe welding — offshore pipe spools, risers, process piping');
  if (pipe) fits.push('pipefitting and pipe welding on fabrication and shutdown scopes');
  if (grp?.token?.startsWith('1')) fits.push('thick-wall carbon steel — jackets, monopiles, transition pieces, structural fabrication');
  if (has('Thickness')[0]?.range?.includes('no upper limit')) fits.push('heavy plate and heavy wall — no upper thickness limit on this ticket');
  if (processes.includes('136') || processes.includes('138')) fits.push('yard and site production welding, where flux- and metal-cored MAG is the normal process');
  if (processes.includes('141')) fits.push('root runs and stainless or alloy work where TIG is specified');

  return { can, cannot, trades: [...trades], fits };
}

/** Does this text look like an ISO 9606 designation at all? */
export const looksLikeIso9606 = (s?: string | null) => !!s && /9606/i.test(s);
