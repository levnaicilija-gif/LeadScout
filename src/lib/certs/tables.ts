/**
 * What a certificate means — by lookup, never by inference.
 *
 * Same three layers as the ISO 9606 decoder, for the schemes that are a level rather than a
 * coded designation: what it says, what the holder can do, what it does not cover. Plus the two
 * commercial facts a recruiter needs before they pick up the phone — who asks for it, and how
 * long it lasts.
 *
 * Where a fact is not certain it is marked `confirm`, and the card shows it as needing a
 * senior's confirmation rather than stating it. A validity period quoted confidently and wrongly
 * is how a man arrives on site with an expired ticket, so "we have not checked this" is the
 * more useful sentence. Seniors correct these in Settings; their edit shadows the shipped row
 * and survives an update.
 */
import type { Trade } from '../trades';

export type CertEntry = {
  body: string;                 // the key intake stores in documents.cert_body
  level?: string;               // the printed level this row is about; absent = the scheme itself
  match?: RegExp;               // how to recognise that level on the document
  title: string;
  meaning: string;              // what it says
  covers: string;               // what the holder can do
  notCovered: string;           // what it does not cover
  whoRequires: string;
  validity: string;
  verification: string;
  trades: Trade[];
  confirm?: string;             // what a senior must check before this is quoted to a client
};

const T = (...t: Trade[]) => t;

export const CERT_TABLE: CertEntry[] = [
  // ------------------------------------------------------------------ NDT
  {
    body: 'pcn', level: '3', match: /\b(level\s*)?3\b|\blevel iii\b/i,
    title: 'PCN Level 3',
    meaning: 'Certification to ISO 9712 issued by BINDT. Level 3 is the grade that carries technical responsibility for a method: it writes and signs the procedures the others work to.',
    covers: 'Writes NDT procedures, approves them, interprets codes and standards, and supervises level 1 and 2 technicians. Can take responsibility for a method on a contract.',
    notCovered: 'Only the methods and sectors printed on the card. A level 3 in UT is not a level 3 in radiography, and a weldments sector does not cover castings.',
    whoRequires: 'Operators and EPC contractors on any scope where NDT is contractual — pipelines, pressure equipment, structural fabrication.',
    validity: '5 years, with recertification at 10 years.',
    verification: 'BINDT public register — searchable by PCN number or surname.',
    trades: T('ndt'),
  },
  {
    body: 'pcn', level: '2', match: /\b(level\s*)?2\b|\b2d\b|\blevel ii\b/i,
    title: 'PCN Level 2',
    meaning: 'Certification to ISO 9712 issued by BINDT. Level 2 performs the inspection, sets up the equipment, interprets the result against a written procedure and reports it.',
    covers: 'Carries out and reports inspections to a procedure, and may write working instructions. This is the grade most yards and operators mean when they ask for "a PCN technician".',
    notCovered: 'Writing or approving procedures — that is level 3. And only the methods and sectors on the card.',
    whoRequires: 'Fabrication yards, pipeline contractors, shutdown and turnaround scopes.',
    validity: '5 years, with recertification at 10 years.',
    verification: 'BINDT public register — searchable by PCN number or surname.',
    trades: T('ndt'),
  },
  {
    body: 'pcn', level: '1', match: /\b(level\s*)?1\b|\blevel i\b/i,
    title: 'PCN Level 1',
    meaning: 'Certification to ISO 9712 issued by BINDT. Level 1 performs the inspection under the direction of a level 2 or 3.',
    covers: 'Sets up equipment and carries out inspections under supervision, to written instructions.',
    notCovered: 'Interpreting or reporting results independently, and writing instructions or procedures.',
    whoRequires: 'Larger NDT crews, usually alongside a level 2.',
    validity: '5 years, with recertification at 10 years.',
    verification: 'BINDT public register.',
    trades: T('ndt'),
  },
  {
    body: 'iso9712',
    title: 'ISO 9712 NDT certification',
    meaning: 'The international standard behind most NDT personnel certification. A certificate names a level (1, 2 or 3), a method (UT, MT, PT, RT, ET, VT) and an industrial sector.',
    covers: 'What the level and method say: level 1 works under supervision, level 2 performs and reports, level 3 writes procedures and takes technical responsibility.',
    notCovered: 'Methods and sectors not printed on it. The issuing body matters commercially — some clients name PCN or CSWIP specifically and will not take another ISO 9712 scheme.',
    whoRequires: 'Anywhere NDT is contractual across the EU.',
    validity: '5 years, with recertification at 10 years.',
    verification: 'Depends on the issuing body — PCN and CSWIP have public registers; many national schemes do not.',
    trades: T('ndt'),
  },

  // -------------------------------------------------------- welding inspection
  {
    body: 'cswip', level: '3.2', match: /3\.?2|senior welding inspector/i,
    title: 'CSWIP 3.2 Senior Welding Inspector',
    meaning: 'TWI certification. The senior weld inspection grade: supervises inspection, signs off welds, and takes responsibility for the inspection of a contract.',
    covers: 'Supervises welding inspectors, approves inspection records, signs off completed welds, and interprets welding standards and procedures.',
    notCovered: 'Welding itself — this is an inspection qualification, not a welder qualification. And NDT interpretation beyond visual, which needs PCN or an ISO 9712 certificate.',
    whoRequires: 'Operators and EPC contractors on offshore and pressure work; usually a named role in the contract.',
    validity: '5 years, renewable.',
    verification: 'TWI certificate check — by certificate number.',
    trades: T('welder', 'ndt'),
  },
  {
    body: 'cswip', level: '3.1', match: /3\.?1|welding inspector/i,
    title: 'CSWIP 3.1 Welding Inspector',
    meaning: 'TWI certification. The standard weld inspection grade offshore and in fabrication.',
    covers: 'Inspects welds against a procedure and a standard, checks weld preparation, records and reports. Visual inspection to a documented acceptance criterion.',
    notCovered: 'Signing off as a senior inspector, and any NDT method beyond visual.',
    whoRequires: 'Fabrication yards, offshore construction, pipeline spreads.',
    validity: '5 years, renewable.',
    verification: 'TWI certificate check.',
    trades: T('welder', 'ndt'),
  },
  {
    body: 'cswip', level: '3.0', match: /3\.?0|visual/i,
    title: 'CSWIP 3.0 Visual Welding Inspector',
    meaning: 'TWI certification covering visual examination of welds only.',
    covers: 'Visual inspection of welds and weld preparation against an acceptance standard.',
    notCovered: 'The wider inspection duties of 3.1, and any NDT method.',
    whoRequires: 'Yards wanting a visual check in the production line rather than a contract inspector.',
    validity: '5 years, renewable.',
    verification: 'TWI certificate check.',
    trades: T('welder'),
  },

  // ------------------------------------------------------- coating and blasting
  {
    body: 'frosio', level: 'III', match: /\biii\b|\blevel\s*3\b|\b3\b/i,
    title: 'FROSIO Inspector Level III',
    meaning: 'Norwegian surface treatment inspector scheme. Level III is the senior grade, awarded on examination result and documented experience.',
    covers: 'Plans, specifies and signs off surface treatment work, and supervises inspectors. The grade Norwegian operators name in a coating specification.',
    notCovered: 'Applying coating — it is an inspection qualification. And welding or NDT of any kind.',
    whoRequires: 'Norwegian operators and yards; widely accepted across the North Sea in place of AMPP.',
    validity: '5 years, renewable.',
    verification: 'FROSIO public register — searchable by certificate number or name.',
    trades: T('painter', 'blaster'),
  },
  {
    body: 'frosio', level: 'II', match: /\bii\b|\blevel\s*2\b|\b2\b/i,
    title: 'FROSIO Inspector Level II',
    meaning: 'Norwegian surface treatment inspector scheme. Level II is the grade most yards ask for.',
    covers: 'Inspects and documents surface treatment on site — surface preparation, climate conditions, film thickness, holiday detection — against a coating specification.',
    notCovered: 'Applying coating, and signing off as a senior inspector on specification questions.',
    whoRequires: 'Norwegian and North Sea yards and coating contractors.',
    validity: '5 years, renewable.',
    verification: 'FROSIO public register.',
    trades: T('painter', 'blaster'),
  },
  {
    body: 'frosio', level: 'I', match: /\bi\b|\blevel\s*1\b|\b1\b/i,
    title: 'FROSIO Inspector Level I',
    meaning: 'Norwegian surface treatment inspector scheme, entry grade.',
    covers: 'Assists inspection under a level II or III, and records measurements.',
    notCovered: 'Independent inspection and sign-off.',
    whoRequires: 'Larger coating crews alongside a senior inspector.',
    validity: '5 years, renewable.',
    verification: 'FROSIO public register.',
    trades: T('painter', 'blaster'),
  },
  {
    body: 'ampp', level: '3', match: /\b(level\s*)?3\b|peer review/i,
    title: 'AMPP CIP Level 3',
    meaning: 'AMPP Coating Inspector Program, the scheme formed when NACE and SSPC merged. Level 3 is the senior grade, reached through peer review.',
    covers: 'Senior coating inspection: specification review, procedure approval, and supervision of inspectors on large coating contracts.',
    notCovered: 'Applying coating, welding, and NDT.',
    whoRequires: 'Operators outside Norway, particularly on US-specified and Middle East work.',
    validity: '3 years, with continuing-education renewal.',
    verification: 'AMPP certification directory.',
    trades: T('painter', 'blaster'),
  },
  {
    body: 'ampp', level: '2', match: /\b(level\s*)?2\b/i,
    title: 'AMPP CIP Level 2',
    meaning: 'AMPP Coating Inspector Program level 2 — the working inspection grade, equivalent in practice to FROSIO level II.',
    covers: 'Inspects and documents surface preparation and coating application against a specification, on site.',
    notCovered: 'Applying coating. Some Norwegian specifications name FROSIO and will not take AMPP in its place — check the specification.',
    whoRequires: 'Coating contractors and operators outside Scandinavia.',
    validity: '3 years, with continuing-education renewal.',
    verification: 'AMPP certification directory.',
    trades: T('painter', 'blaster'),
  },
  {
    body: 'ampp', level: '1', match: /\b(level\s*)?1\b/i,
    title: 'AMPP CIP Level 1',
    meaning: 'AMPP Coating Inspector Program level 1 — entry grade, works under a level 2 or 3.',
    covers: 'Takes and records coating measurements under supervision.',
    notCovered: 'Independent inspection and sign-off.',
    whoRequires: 'Larger coating crews.',
    validity: '3 years.',
    verification: 'AMPP certification directory.',
    trades: T('painter', 'blaster'),
  },
  {
    body: 'icats',
    title: 'ICATS — Industrial Coating Applicator Training Scheme',
    meaning: 'A UK applicator scheme: the card records the modules the holder has been trained and assessed in — surface preparation, spray application, and so on. It is an applicator scheme, not an inspection one.',
    covers: 'The coating application modules printed on the card. This is the card UK principal contractors ask painters and blasters for.',
    notCovered: 'Coating inspection — that is FROSIO or AMPP. Modules not on the card.',
    whoRequires: 'UK principal contractors and bridge, rail and structural steel work.',
    validity: '3 years.',
    verification: 'ICATS scheme register via the issuing training provider.',
    trades: T('painter', 'blaster'),
    confirm: 'Check the modules printed on the card against what the job actually needs — the card is a list, not a level.',
  },

  // -------------------------------------------------------------- rope access
  {
    body: 'irata', level: '3', match: /\b3\b|level 3|supervisor/i,
    title: 'IRATA Level 3 — Rope Access Supervisor',
    meaning: 'Industrial Rope Access Trade Association certification. Level 3 supervises the rope access team and owns the rescue plan.',
    covers: 'Supervises rope access work, writes and executes the rescue plan, and is the person a site requires before any rope team may work.',
    notCovered: 'The trade done at height. A level 3 rope access ticket is not a welding, NDT or blade-repair qualification — those are separate and must be held as well.',
    whoRequires: 'Any offshore or wind site running rope access; a level 3 on site is usually a condition of the permit.',
    validity: '3 years, with a revalidation assessment.',
    verification: 'IRATA — held through the member company; not a fully public register.',
    trades: T('rope access'),
  },
  {
    body: 'irata', level: '2', match: /\b2\b|level 2/i,
    title: 'IRATA Level 2 — Rope Access Technician',
    meaning: 'IRATA certification. Level 2 can rig, and can perform rescues, under a level 3 supervisor.',
    covers: 'Rigging, rope transfers, deviations, aid climbing and rescue, under supervision.',
    notCovered: 'Supervising a team, and the trade performed at height.',
    whoRequires: 'Rope access crews offshore and in wind.',
    validity: '3 years.',
    verification: 'IRATA — through the member company.',
    trades: T('rope access'),
  },
  {
    body: 'irata', level: '1', match: /\b1\b|level 1/i,
    title: 'IRATA Level 1 — Rope Access Technician',
    meaning: 'IRATA certification, entry grade.',
    covers: 'Works on rope under a level 3 supervisor, performing pre-rigged manoeuvres.',
    notCovered: 'Rigging and rescue, supervision, and the trade performed at height.',
    whoRequires: 'Rope access crews, always alongside a level 3.',
    validity: '3 years.',
    verification: 'IRATA — through the member company.',
    trades: T('rope access'),
  },

  // ------------------------------------------------------------------- wind
  {
    body: 'winda',
    title: 'GWO training, recorded in WINDA',
    meaning: 'Global Wind Organisation training. WINDA is the register the records live in; the modules are what matters. Basic Safety Training (BST) is the baseline — working at height, manual handling, fire awareness, first aid, and sea survival for offshore.',
    covers: 'The modules recorded against the WINDA ID. BST is what gets a technician onto a turbine at all; Basic Technical Training, Advanced Rescue, Blade Repair and Slinger Signaller are separate modules on top.',
    notCovered: 'Anything not recorded in WINDA, and the trade itself — GWO is safety training, not a technical qualification.',
    whoRequires: 'Every wind site, onshore and offshore, in Europe.',
    validity: 'BST refreshes every 24 months. Sea survival lapses with it for offshore work.',
    verification: 'WINDA — the record is the register; confirm the modules and dates by WINDA ID.',
    trades: T('wind technician', 'electrician', 'rope access'),
  },

  // --------------------------------------------------------- offshore survival
  {
    body: 'opito',
    title: 'BOSIET / FOET — OPITO offshore survival',
    meaning: 'OPITO-approved offshore safety and emergency training. BOSIET is the initial course and includes helicopter underwater escape (HUET); FOET is the refresher. Where the sector requires it, the course carries the CA-EBS variant for compressed-air emergency breathing.',
    covers: 'Travel to and work on an offshore installation: helicopter escape, sea survival, firefighting and first aid. Without it, a man does not get on the helicopter.',
    notCovered: 'Any trade at all — it is survival training. And it does not substitute for GWO on a wind site, or the reverse.',
    whoRequires: 'Every offshore oil and gas installation in the UK and Norwegian sectors.',
    validity: '4 years, refreshed by FOET.',
    verification: 'OPITO — check the certificate against the OPITO-approved centre that issued it.',
    trades: T('welder', 'pipefitter', 'fitter', 'painter', 'blaster', 'ndt', 'scaffolder', 'electrician', 'rope access'),
    confirm: 'Check whether the job needs the CA-EBS variant and which sector (UK or Norwegian) the certificate was issued for — they are not always interchangeable.',
  },

  // -------------------------------------------------------- scaffolding, cards
  {
    body: 'cisrs', level: 'advanced', match: /advanced/i,
    title: 'CISRS Advanced Scaffolder',
    meaning: 'Construction Industry Scaffolders Record Scheme, advanced grade. The card records the grade and the date it runs out.',
    covers: 'Complex and design scaffolds — cantilevers, truss-outs, suspended and temporary roof work — as well as everything a scaffolder card covers.',
    notCovered: 'Supervision and scaffold inspection, which are separate CISRS cards.',
    whoRequires: 'UK sites, and increasingly named in offshore access contracts.',
    validity: '5 years.',
    verification: 'CISRS card check by card number.',
    trades: T('scaffolder'),
  },
  {
    body: 'cisrs',
    title: 'CISRS Scaffolder',
    meaning: 'Construction Industry Scaffolders Record Scheme. The recognised UK scaffolding card, showing the grade held.',
    covers: 'Erecting, altering and dismantling scaffold to the grade printed on the card.',
    notCovered: 'Advanced scaffolds, supervision and inspection — each a separate card.',
    whoRequires: 'UK construction and industrial sites.',
    validity: '5 years.',
    verification: 'CISRS card check by card number.',
    trades: T('scaffolder'),
  },
  {
    body: 'cscs',
    title: 'CSCS card',
    meaning: 'Construction Skills Certification Scheme — the general UK site access card. The colour is the grade: green for labourer, blue for skilled, gold for advanced or supervisor, black for manager.',
    covers: 'Site access in the UK, at the occupation and level printed on it. It records a qualification already held; it is not itself a trade qualification.',
    notCovered: 'Any trade competence of its own, and any site outside the UK.',
    whoRequires: 'UK principal contractors, as a condition of entry.',
    validity: '5 years.',
    verification: 'CSCS online card checker.',
    trades: T('welder', 'pipefitter', 'fitter', 'painter', 'blaster', 'scaffolder', 'electrician'),
  },

  // --------------------------------------------------------- safety, by country
  {
    body: 'vca',
    title: 'VCA / SCC safety certificate',
    meaning: 'Dutch and Belgian VCA, German and Austrian SCC — the same scheme under different names. B-VCA is for operatives, VOL-VCA for supervisors and managers, VIL-VCU for agency intermediaries.',
    covers: 'Site access in the Netherlands, Belgium, Germany and Austria: safe working, risk awareness and the local safety regime. VOL-VCA is the one asked for when the person will supervise.',
    notCovered: 'Any trade competence, and countries outside the scheme.',
    whoRequires: 'Effectively every Dutch, Belgian and German industrial site and shipyard.',
    validity: '10 years.',
    verification: 'Centraal Diploma Register (CDR) — searchable.',
    trades: T('welder', 'pipefitter', 'fitter', 'painter', 'blaster', 'ndt', 'scaffolder', 'electrician'),
  },
  {
    body: 'fse',
    title: 'FSE — Norwegian electrical safety regulations training',
    meaning: 'Annual training in the Norwegian regulations for safe work on and operation of electrical installations (Forskrift om sikkerhet ved arbeid i og drift av elektriske anlegg). It is a training requirement, not a trade qualification.',
    covers: 'Being allowed to work on or near live Norwegian electrical installations under the employer\'s safety regime, together with first aid training.',
    notCovered: 'Electrical trade competence, which comes from the trade qualification, and the installing company\'s own authorisation.',
    whoRequires: 'Norwegian operators, yards and electrical contractors.',
    validity: 'Annual — it must be repeated every 12 months.',
    verification: 'Held by the employer or training provider; no public register.',
    trades: T('electrician'),
    confirm: 'Confirm the date of the most recent annual session, not just that the course was ever taken — this one lapses faster than anything else on a profile.',
  },
  {
    body: 'epoxy_dk',
    title: 'Danish §17 — epoxy and isocyanate work',
    meaning: 'The Danish statutory course required before working with epoxy resins and isocyanates, from the Danish Working Environment Authority rules on coded products.',
    covers: 'Working with two-component epoxy and polyurethane coatings on Danish sites — which is most industrial painting and deck coating work there.',
    notCovered: 'Any coating competence of its own, and any country but Denmark.',
    whoRequires: 'Danish yards and coating contractors, as a legal precondition.',
    validity: 'Confirm — not encoded here.',
    verification: 'Held by the training provider; confirm with the issuer.',
    trades: T('painter', 'blaster'),
    confirm: 'Confirm the exact scope and renewal period with the issuing provider before quoting this to a Danish client — only the requirement itself is certain here.',
  },
  {
    body: 'udt',
    title: 'UDT — Polish Office of Technical Inspection licence',
    meaning: 'A Polish operator licence issued by Urząd Dozoru Technicznego for a named category of equipment — cranes, hoists, forklifts, aerial platforms, pressure equipment. The category on the licence is the whole of it.',
    covers: 'Operating the equipment category printed on the licence, in Poland and often accepted elsewhere alongside a local conversion.',
    notCovered: 'Any category not on the licence, and any trade competence beyond operating that equipment.',
    whoRequires: 'Polish yards and sites; also asked for when a Polish crew brings its own lifting operators.',
    validity: 'Varies by equipment category — read the date on the licence.',
    verification: 'UDT register (eUDT), by licence number.',
    trades: T('fitter', 'scaffolder'),
    confirm: 'Read the equipment category off the licence — "UDT" alone says nothing about what the holder may operate.',
  },

  // ------------------------------------------------------------------ welding
  {
    body: 'iso9606',
    title: 'ISO 9606 welder qualification',
    meaning: 'A welder qualification test. Everything about it is in the designation printed on it — process, product form, weld type, parent metal, consumable, thickness, diameter, position and root treatment.',
    covers: 'Exactly what the designation covers, which the card decodes line by line above.',
    notCovered: 'Any process, position or material outside the designation, and anything other than welding.',
    whoRequires: 'Every yard, EPC contractor and operator that employs welders.',
    validity: 'Normally 3 years with 6-monthly employer confirmation of continuous work; the certificate states its own terms.',
    verification: 'No public register. Confirmed with the issuing body (TÜV, Bureau Veritas, DNV, Lloyd\'s) by certificate number, and cross-checked against the welding test report.',
    trades: T('welder'),
  },
];

/** Look a certificate up. Most specific level first; the scheme row is the fallback. */
export function lookupCert(body?: string | null, level?: string | null, extra?: string | null): CertEntry | null {
  const key = String(body ?? '').toLowerCase().trim();
  if (!key) return null;
  const rows = CERT_TABLE.filter((r) => r.body === key);
  if (!rows.length) return null;
  const hay = `${level ?? ''} ${extra ?? ''}`.trim();
  if (hay) {
    const hit = rows.find((r) => r.match && r.match.test(hay));
    if (hit) return hit;
  }
  // No level read, or none matched: the scheme row if there is one, otherwise nothing —
  // returning the senior grade because it is first in the list would promote every holder.
  return rows.find((r) => !r.level) ?? null;
}

/** Every body the table knows, for the library and the "unrecognised" check. */
export const KNOWN_BODIES = [...new Set(CERT_TABLE.map((r) => r.body))];
export const knowsBody = (body?: string | null) => KNOWN_BODIES.includes(String(body ?? '').toLowerCase().trim());
