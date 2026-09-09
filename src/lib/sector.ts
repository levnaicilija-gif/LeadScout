/** RFBT's sectors, inferred from a company name. Recorded as a guess, never as fact. */
export type Sector = 'offshore_wind' | 'shipyard' | 'oil_gas' | 'epc' | 'industrial' | 'other';

const RULES: { sector: Sector; match: RegExp }[] = [
  { sector: 'offshore_wind', match: /\b(wind|windpower|vindm|offshore wind|turbine|blade|nacelle|monopile|vestas|siemens gamesa|orsted|ørsted|nordex|enercon)\b/i },
  { sector: 'shipyard', match: /\b(shipyard|verft|værft|werft|scheepswerf|astillero|cantiere|stocznia|marine|maritime|naval|shipbuilding|drydock|damen|meyer|fincantieri|navantia)\b/i },
  { sector: 'oil_gas', match: /\b(oil|gas|petro|refinery|lng|upstream|subsea|drilling|wellhead|aker bp|equinor|shell|totalenergies|conoco)\b/i },
  { sector: 'epc', match: /\b(epc|epci|engineering|contractor|construction|fabrication|industri|industries|installation|heerema|saipem|subsea 7|technipfmc|mcdermott|bilfinger)\b/i },
  { sector: 'industrial', match: /\b(steel|metal|coating|painting|blasting|insulation|scaffold|isolering|corrosion|surface treatment|manufactur|works|plant)\b/i },
];

export function sectorFor(name: string, extra?: string | null): Sector {
  const t = `${name} ${extra ?? ''}`;
  for (const r of RULES) if (r.match.test(t)) return r.sector;
  return 'other';
}
