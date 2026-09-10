/**
 * One line of plain English per certificate level, and what it qualifies someone to do in our
 * taxonomy. A recruiter reading "FROSIO Level III" should not have to know what that means.
 *
 * These are trade-card content, not verification: they describe the certificate, never its
 * status. Keyed by body, then matched on the level as printed.
 */
import { RFBT_TRADE_LIST } from './trades';

export type LevelNote = { match: RegExp; explains: string; covers: string[]; coversText: string };

const CARDS: Record<string, LevelNote[]> = {
  frosio: [
    { match: /\biii\b|\b3\b/i, explains: 'Inspector level III — the senior FROSIO grade: plans and signs off surface treatment work and supervises inspectors.', covers: ['painter', 'blaster'] , coversText: "Surface treatment inspector — coating inspection, specification and sign-off on painting and blasting work" },
    { match: /\bii\b|\b2\b/i, explains: 'Inspector level II — the grade most yards ask for: inspects and documents surface treatment on site.', covers: ['painter', 'blaster'] , coversText: "Surface treatment inspector — on-site coating inspection and documentation for painters and blasters" },
    { match: /\bi\b|\b1\b/i, explains: 'Inspector level I — assists inspection under supervision.', covers: ['painter', 'blaster'] , coversText: "Assistant coating inspector — works under a senior inspector on painting and blasting" },
  ],
  pcn: [
    { match: /\b3\b|level 3/i, explains: 'PCN level 3 — writes NDT procedures and takes technical responsibility for the method.', covers: ['ndt'] , coversText: "Senior NDT technician — writes procedures and carries technical responsibility for the method" },
    { match: /2d|\b2\b/i, explains: 'PCN level 2 — performs and reports the inspection, and may write instructions.', covers: ['ndt'] , coversText: "NDT technician — weld, plate and pipe inspection, reporting to written procedures" },
    { match: /\b1\b/i, explains: 'PCN level 1 — performs the inspection under a level 2 or 3.', covers: ['ndt'] , coversText: "NDT operator — performs inspections under a level 2 or 3" },
  ],
  cswip: [
    { match: /3\.2|senior/i, explains: 'CSWIP 3.2 senior welding inspector — supervises inspection and signs off welds.', covers: ['welder', 'ndt'] , coversText: "Senior welding inspector — supervises weld inspection and signs off" },
    { match: /3\.1|welding inspector/i, explains: 'CSWIP 3.1 welding inspector — the standard weld inspection grade offshore.', covers: ['welder', 'ndt'] , coversText: "Welding inspector — weld inspection on offshore and fabrication work" },
    { match: /3\.0|visual/i, explains: 'CSWIP 3.0 visual welding inspector — visual inspection only.', covers: ['welder'] , coversText: "Visual welding inspector — visual weld inspection only" },
  ],
  irata: [
    { match: /\b3\b/i, explains: 'IRATA level 3 — rope access supervisor, responsible for the team and rescue plan.', covers: ['rope access'] , coversText: "Rope access supervisor — runs the team and the rescue plan at height" },
    { match: /\b2\b/i, explains: 'IRATA level 2 — rope access technician who can rig and perform rescues.', covers: ['rope access'] , coversText: "Rope access technician — rigging and rescue at height" },
    { match: /\b1\b/i, explains: 'IRATA level 1 — rope access technician working under a level 3 supervisor.', covers: ['rope access'] , coversText: "Rope access technician — works at height under a level 3 supervisor" },
  ],
  winda: [{ match: /.*/, explains: 'GWO training recorded in WINDA — the safety baseline every wind site requires.', covers: ['wind technician', 'electrician', 'rope access'] , coversText: "Wind turbine technician, wind electrician, blade rope access — the safety baseline for any wind site" }],
  cisrs: [
    { match: /advanced/i, explains: 'CISRS advanced scaffolder — erects complex and design scaffolds.', covers: ['scaffolder'] , coversText: "Advanced scaffolder — complex and design scaffolds" },
    { match: /.*/, explains: 'CISRS scaffolder card — recognised across UK sites.', covers: ['scaffolder'] , coversText: "Scaffolder — recognised across UK sites" },
  ],
  iso9606: [{ match: /.*/, explains: 'Welder qualification to ISO 9606 — valid for the process, position and material range printed on it.', covers: ['welder'] , coversText: "Welder — for the process, position and material range printed on the certificate" }],
  ampp: [{ match: /.*/, explains: 'AMPP (formerly NACE/SSPC) coating inspection qualification.', covers: ['painter', 'blaster'] , coversText: "Coating inspector — painting and blasting inspection" }],
  electrical_dk: [{ match: /.*/, explains: 'Danish electrical qualification — the authorisation itself sits with the employing company.', covers: ['electrician'] , coversText: "Electrician — under the employing company's authorisation" }],
};

export function levelNote(body?: string | null, level?: string | null, method?: string | null) {
  const list = CARDS[(body ?? '').toLowerCase()];
  if (!list) return null;
  const hay = `${level ?? ''} ${method ?? ''}`.trim();
  const hit = list.find((c) => c.match.test(hay)) ?? list[list.length - 1];
  return hit ? { explains: hit.explains, covers: hit.covers.filter((t) => RFBT_TRADE_LIST.includes(t as any)), coversText: hit.coversText } : null;
}

/** red expired · amber within 90 days · green otherwise. */
export function expiryTone(validUntil?: string | null): { tone: 'ok' | 'warn' | 'bad' | 'none'; days: number | null } {
  if (!validUntil) return { tone: 'none', days: null };
  const t = Date.parse(validUntil);
  if (Number.isNaN(t)) return { tone: 'none', days: null };
  const days = Math.round((t - Date.now()) / 86400000);
  return { tone: days < 0 ? 'bad' : days <= 90 ? 'warn' : 'ok', days };
}
