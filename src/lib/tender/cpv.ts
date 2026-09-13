/**
 * Which contract awards are our kind of work, by CPV code.
 *
 * Every code and label below is copied from the official CPV 2008 vocabulary as the EU
 * Publications Office ships it in the eForms SDK (codelists/cpv.gc). None is typed from memory:
 * `scripts/cpv-check.ts` downloads that file and fails if a code is missing or a label differs.
 *
 * The list is narrow on purpose, and was narrowed against real awards twice:
 *
 *  1. Whole parents — 45310000 "Electrical installation work", 45442000 "Application work of
 *     protective coatings" — caught mostly wiring and repainting in schools and offices: 1,932
 *     TED awards in 30 days. A parent is now only used where every child is industrial, marine or
 *     energy work; building-level siblings such as 45442110 "Painting work of buildings" are out.
 *  2. A week of what was left still made leads of a tiler, a landscaper and a lift company,
 *     because a school build lists a scaffolding or drilling lot among twenty codes. So a notice
 *     now counts only when its PROCEDURE's main classification is on this list (see ingest.ts),
 *     and three parents that let noise through were split: 76000000 (it also holds core drilling
 *     for drinking water and landfill-gas flares), 34510000 (it also holds marine fenders and
 *     floating research kit), and 45231100 (in practice, water and sewer pipe).
 *
 * The trades on each entry are OUR mapping from the scope a code describes to the people it
 * takes. They feed the fit score exactly as Radar's inferred trades do; they are not a fact
 * about the notice, and nothing shows them as one.
 */
import type { Trade } from '@/lib/trades';

export type TenderSector = 'offshore_wind' | 'grid' | 'oil_gas' | 'marine_yard' | 'coating' | 'scaffolding' | 'steel_welding' | 'heat_power';

export type TradeCpv = { code: string; label: string; sector: TenderSector; trades: Trade[] };

export const TRADE_CPV: TradeCpv[] = [
  // Offshore and onshore wind: construction and O&M.
  { code: '45251160', label: 'Wind-power installation works', sector: 'offshore_wind', trades: ['wind technician', 'electrician', 'rope access'] },
  { code: '31121340', label: 'Wind farm', sector: 'offshore_wind', trades: ['wind technician', 'electrician', 'rope access'] },
  { code: '45315200', label: 'Turbine works', sector: 'offshore_wind', trades: ['wind technician', 'electrician', 'fitter'] },
  { code: '51133000', label: 'Installation services of turbines', sector: 'offshore_wind', trades: ['wind technician', 'electrician', 'fitter'] },
  // Grid: the electrical installation work that is not a building.
  { code: '45232200', label: 'Ancillary works for electricity power lines', sector: 'grid', trades: ['electrician'] },
  { code: '45231400', label: 'Construction work for electricity power lines', sector: 'grid', trades: ['electrician'] },
  { code: '45317200', label: 'Electrical installation work of transformers', sector: 'grid', trades: ['electrician'] },
  { code: '45317300', label: 'Electrical installation work of electrical distribution apparatus', sector: 'grid', trades: ['electrician'] },
  // Oil and gas.
  { code: '45255000', label: 'Construction work for the oil and gas industry', sector: 'oil_gas', trades: ['welder', 'pipefitter', 'ndt', 'blaster', 'painter', 'scaffolder'] },
  { code: '45231200', label: 'Construction work for oil and gas pipelines', sector: 'oil_gas', trades: ['welder', 'pipefitter', 'ndt'] },
  { code: '76200000', label: 'Professional services for the oil industry', sector: 'oil_gas', trades: ['welder', 'pipefitter', 'ndt', 'rope access'] },
  { code: '76310000', label: 'Drilling services incidental to gas extraction', sector: 'oil_gas', trades: ['welder', 'fitter', 'electrician', 'ndt'] },
  { code: '76320000', label: 'Offshore drilling services', sector: 'oil_gas', trades: ['welder', 'fitter', 'electrician', 'ndt'] },
  { code: '76500000', label: 'Onshore and offshore services', sector: 'oil_gas', trades: ['welder', 'fitter', 'rope access', 'ndt'] },
  { code: '76600000', label: 'Pipeline-inspection services', sector: 'oil_gas', trades: ['ndt', 'rope access'] },
  { code: '43131000', label: 'Offshore production platforms', sector: 'oil_gas', trades: ['welder', 'fitter', 'blaster', 'painter', 'ndt'] },
  { code: '34514000', label: 'Floating or submersible drilling or production platforms', sector: 'oil_gas', trades: ['welder', 'fitter', 'blaster', 'painter', 'ndt'] },
  { code: '45262421', label: 'Offshore mooring work', sector: 'oil_gas', trades: ['fitter', 'rope access'] },
  { code: '45262424', label: 'Offshore-module fabrication work', sector: 'oil_gas', trades: ['welder', 'fitter', 'blaster', 'painter', 'ndt'] },
  { code: '50246400', label: 'Repair and maintenance services of floating platforms', sector: 'oil_gas', trades: ['welder', 'fitter', 'painter', 'rope access'] },
  // Ships, yards and harbours.
  { code: '34511100', label: 'Marine patrol vessels', sector: 'marine_yard', trades: ['welder', 'fitter', 'pipefitter', 'painter', 'blaster', 'electrician'] },
  { code: '34512000', label: 'Ships and similar vessels for the transport of persons or goods', sector: 'marine_yard', trades: ['welder', 'fitter', 'pipefitter', 'painter', 'blaster', 'electrician'] },
  { code: '34513000', label: 'Fishing, emergency and other special vessels', sector: 'marine_yard', trades: ['welder', 'fitter', 'pipefitter', 'painter', 'blaster', 'electrician'] },
  { code: '50241000', label: 'Repair and maintenance services of ships', sector: 'marine_yard', trades: ['welder', 'fitter', 'pipefitter', 'painter', 'blaster'] },
  { code: '50242000', label: 'Conversion services of ships', sector: 'marine_yard', trades: ['welder', 'fitter', 'pipefitter', 'painter', 'blaster', 'electrician'] },
  { code: '50244000', label: 'Reconditioning services of ships or boats', sector: 'marine_yard', trades: ['welder', 'fitter', 'painter', 'blaster'] },
  { code: '50245000', label: 'Upgrading services of ships', sector: 'marine_yard', trades: ['welder', 'fitter', 'pipefitter', 'electrician'] },
  { code: '50246100', label: 'Dry-docking services', sector: 'marine_yard', trades: ['welder', 'painter', 'blaster'] },
  { code: '45241000', label: 'Harbour construction works', sector: 'marine_yard', trades: ['welder', 'fitter'] },
  { code: '45244000', label: 'Marine construction works', sector: 'marine_yard', trades: ['welder', 'fitter'] },
  { code: '45248200', label: 'Dry docks construction work', sector: 'marine_yard', trades: ['welder', 'fitter'] },
  // Industrial coating: structures, not buildings.
  { code: '45442120', label: 'Painting and protective-coating work of structures', sector: 'coating', trades: ['painter', 'blaster'] },
  { code: '45442121', label: 'Painting work of structures', sector: 'coating', trades: ['painter', 'blaster'] },
  { code: '45442200', label: 'Application work of anti-corrosive coatings', sector: 'coating', trades: ['painter', 'blaster'] },
  { code: '90912000', label: 'Blast-cleaning services for tubular structures', sector: 'coating', trades: ['blaster', 'painter'] },
  // Scaffolding.
  { code: '45262100', label: 'Scaffolding work', sector: 'scaffolding', trades: ['scaffolder'] },
  // Structural steel and welding.
  { code: '45223100', label: 'Assembly of metal structures', sector: 'steel_welding', trades: ['welder', 'fitter'] },
  { code: '45223210', label: 'Structural steelworks', sector: 'steel_welding', trades: ['welder', 'fitter'] },
  { code: '45262420', label: 'Structural steel erection work for structures', sector: 'steel_welding', trades: ['welder', 'fitter'] },
  { code: '45262680', label: 'Welding', sector: 'steel_welding', trades: ['welder'] },
  // District heating mains (welded steel pipe) and power and heating plants.
  { code: '45232140', label: 'District-heating mains construction work', sector: 'heat_power', trades: ['welder', 'pipefitter'] },
  { code: '45251000', label: 'Construction works for power plants and heating plants', sector: 'heat_power', trades: ['welder', 'pipefitter', 'electrician', 'scaffolder'] },
];

/**
 * Award notices only — the work has been won, so there is a company to call.
 *
 * Deliberately excluded, each seen in a 250-notice sample of this list:
 *   can-modif  a change to a contract already awarded (67 of 250) — not a new win;
 *   veat       an intention to award without competition — not yet an award;
 *   can-desg   design-contest results — architects, not trades.
 */
export const AWARD_NOTICE_TYPES = ['can-standard', 'can-social', 'can-tran'] as const;

/**
 * Is `code` this entry or one of its descendants?
 *
 * The first five digits of a CPV code are positional — division, group, class, category — so
 * down to a category, descendants are exactly the codes sharing the significant digits. Below
 * that they are not: 45232141 "Heating works" is a SIBLING of 45232140 "District-heating mains
 * construction work", both children of 45232100, and a prefix rule filed school heating
 * installations as district heating. So an entry with more than five significant digits matches
 * itself only.
 */
function covers(entry: string, code: string) {
  const stem = entry.replace(/0+$/, '');
  return stem.length > 5 ? code === entry : code.startsWith(stem.padEnd(2, '0'));
}

/** Which of our entries these CPV codes fall under. Empty means it is not our work. */
export function tradeCpvFor(codes: string[]): TradeCpv[] {
  const hits = new Map<string, TradeCpv>();
  for (const raw of codes) {
    const code = String(raw).replace(/-\d$/, '').trim();
    for (const e of TRADE_CPV) if (covers(e.code, code)) hits.set(e.code, e);
  }
  return [...hits.values()];
}
