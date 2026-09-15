/**
 * Item 24: the candidate pool's boolean search, held to its rules and timed at scale. In the release gate; no network.
 *
 *   npx tsx scripts/candidate-search-check.ts
 *
 * Correctness — on hand-written candidates: AND, OR, NOT, parentheses, NOT > AND > OR precedence, adjacent terms as AND,
 * "quoted phrases", lower-case and/or/not as ordinary words, accents and case ignored, and every malformed query answered
 * with an error that says where (never an empty result that reads as "nobody matches").
 * Scale — 3,000 synthetic candidates from a fixed seed (no Math.random): each query's result is compared with an
 * independently written filter over the same records, and the median time to parse and filter is reported.
 */
import { parseQuery, matches, describe, fold } from '../src/lib/candidate-search';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); };

const people = {
  marko: fold('#4 RFBT-P-0004 Marko Jovanović painter blaster Norway FROSIO level III contract notes: not available until March client: AIBEL placed at AIBEL'),
  ana: fold('#9 RFBT-F-0009 Ana Popescu pipefitter Denmark CSWIP 3.1 permanent client: Semco Maritime'),
  lars: fold('#12 RFBT-W-0012 Lars Nilsen welder Norway ISO 9606 level 2 either client: Aker Solutions'),
  jan: fold('#15 RFBT-N-0015 Jan de Vries NDT inspector Netherlands PCN level 2 contract'),
};
const who = (q: string) => {
  const p = parseQuery(q);
  if (!p.ok) return `error: ${p.error}`;
  return Object.entries(people).filter(([, h]) => matches(p.node, h)).map(([k]) => k).join(',');
};

(async () => {
  console.log('Correctness');
  check(who('norway') === 'marko,lars', 'a single term', who('norway'));
  check(who('norway AND welder') === 'lars', 'AND', who('norway AND welder'));
  check(who('norway welder') === 'lars', 'adjacent terms are AND', who('norway welder'));
  check(who('denmark OR netherlands') === 'ana,jan', 'OR', who('denmark OR netherlands'));
  check(who('norway AND NOT welder') === 'marko', 'NOT', who('norway AND NOT welder'));
  check(who('painter OR welder AND denmark') === 'marko', 'AND binds tighter than OR: painter OR (welder AND denmark)', who('painter OR welder AND denmark'));
  check(who('(painter OR welder) AND norway') === 'marko,lars', 'parentheses override precedence', who('(painter OR welder) AND norway'));
  check(who('NOT (norway OR denmark)') === 'jan', 'NOT applies to a whole group', who('NOT (norway OR denmark)'));
  check(who('"level 2"') === 'lars,jan', 'a quoted phrase matches as one', who('"level 2"'));
  check(who('"not available"') === 'marko' && who('not available') === 'marko', 'lower-case not/and/or are ordinary words', `${who('"not available"')} · ${who('not available')}`);
  check(who('jovanovic') === 'marko' && who('POPESCU') === 'ana', 'accents and case are ignored', `${who('jovanovic')} · ${who('POPESCU')}`);
  check(fold('Ørsted Łukasz Đorđević Æsir Straße') === 'orsted lukasz dordevic aesir strasse', 'letters Unicode does not decompose are folded too (Ø, Ł, Đ, Æ, ß)', fold('Ørsted Łukasz Đorđević Æsir Straße'));
  check(who('#4') === 'marko' && who('RFBT-F-0009') === 'ana', 'the candidate number and the reference code are searchable', `${who('#4')} · ${who('RFBT-F-0009')}`);
  check(who('aibel') === 'marko' && who('"placed at aibel"') === 'marko', 'client history is searchable', who('aibel'));
  check(who('contract AND (norway OR netherlands) AND NOT painter') === 'jan', 'a realistic nested query', who('contract AND (norway OR netherlands) AND NOT painter'));
  check(who('') === 'marko,ana,lars,jan', 'an empty search matches everyone');
  for (const [q, want] of [
    ['(welder', /never closed/], ['welder AND', /AND at character 8 has nothing after it/], ['NOT', /NOT at character 1 has nothing after it/],
    ['welder)', /closing parenthesis at character 7 has no opening one/], ['"level 2', /quote opened at character 1 is never closed/], ['()', /parentheses at character 1 are empty/],
    ['OR welder', /OR at character 1 has nothing before it/], ['welder OR', /OR at character 8 has nothing after it/],
  ] as [string, RegExp][]) {
    const r = who(q);
    check(r.startsWith('error: ') && want.test(r), `"${q}" is refused with where it went wrong`, r);
  }
  const p = parseQuery('welder AND (norway OR denmark) AND NOT "level 1"');
  check(p.ok && describe(p.node) === 'welder AND (norway OR denmark) AND NOT "level 1"', 'the query reads back the way it was understood', p.ok ? describe(p.node) : p.error);

  console.log('\nScale — 3,000 synthetic candidates, fixed seed');
  let seed = 20260915;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const TRADES = ['painter', 'blaster', 'welder', 'pipefitter', 'scaffolder', 'insulator', 'electrician', 'rope access technician', 'ndt inspector', 'plate fitter'];
  const COUNTRIES = ['Norway', 'Denmark', 'Poland', 'Romania', 'Serbia', 'Portugal', 'Spain', 'Netherlands', 'Germany', 'United Kingdom'];
  const CERTS = ['FROSIO level II', 'FROSIO level III', 'CSWIP 3.1', 'PCN level 2', 'ISO 9606 138 P BW', 'IRATA level 2', 'GWO BST', 'AMPP CIP level 2', 'CISRS advanced', 'NACE level 1'];
  const PREFS = ['permanent', 'contract', 'either'];
  const CLIENTS = ['AIBEL', 'Semco Maritime', 'Aker Solutions', 'Kvaerner', 'Bladt Industries', 'Damen', 'Worley', 'Ørsted', 'Vestas', 'Equinor'];
  const FIRST = ['Marko', 'Ana', 'Lars', 'Jan', 'Piotr', 'Ionuț', 'João', 'Miguel', 'Sven', 'Dragan', 'Tomasz', 'Mihai'];
  const LAST = ['Jovanović', 'Popescu', 'Nilsen', 'de Vries', 'Kowalski', 'Ionescu', 'Silva', 'García', 'Hansen', 'Petrović', 'Nowak', 'Dumitru'];
  type Rec = { n: number; name: string; trade: string; country: string; certs: string[]; pref: string; notes: string; sentTo: string[]; placedAt: string | null };
  const recs: Rec[] = Array.from({ length: 3000 }, (_, i) => {
    const certs = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(CERTS));
    const sentTo = Array.from({ length: Math.floor(rnd() * 3) }, () => pick(CLIENTS));
    return { n: 200 + i, name: `${pick(FIRST)} ${pick(LAST)}`, trade: pick(TRADES), country: pick(COUNTRIES), certs, pref: pick(PREFS), notes: rnd() < 0.2 ? 'not available until spring' : rnd() < 0.5 ? 'offshore experience, own tools' : '', sentTo, placedAt: rnd() < 0.08 ? pick(CLIENTS) : null };
  });
  const text = (r: Rec) => fold([`#${r.n}`, r.name, r.trade, r.country, ...r.certs, r.pref, r.notes, ...r.sentTo.map((c) => `sent to ${c}`), r.placedAt ? `placed at ${r.placedAt}` : ''].join(' | '));
  const has = (r: Rec, s: string) => text(r).includes(fold(s));
  const QUERIES: { q: string; oracle: (r: Rec) => boolean }[] = [
    { q: 'welder AND norway', oracle: (r) => r.trade === 'welder' && r.country === 'Norway' },
    { q: '(painter OR blaster) AND (FROSIO OR AMPP) AND NOT romania', oracle: (r) => ['painter', 'blaster'].includes(r.trade) && r.certs.some((c) => /FROSIO|AMPP/.test(c)) && r.country !== 'Romania' },
    { q: '"placed at aibel"', oracle: (r) => r.placedAt === 'AIBEL' },
    { q: 'contract AND "cswip 3.1" AND NOT "not available"', oracle: (r) => r.pref === 'contract' && r.certs.includes('CSWIP 3.1') && r.notes !== 'not available until spring' },
    { q: 'orsted OR equinor', oracle: (r) => r.sentTo.some((c) => c === 'Ørsted' || c === 'Equinor') || r.placedAt === 'Ørsted' || r.placedAt === 'Equinor' },
    { q: 'NOT (norway OR denmark) AND scaffolder AND either', oracle: (r) => !['Norway', 'Denmark'].includes(r.country) && r.trade === 'scaffolder' && r.pref === 'either' },
  ];
  const haystacks = recs.map(text);
  for (const { q, oracle } of QUERIES) {
    const want = recs.filter(oracle).map((r) => r.n);
    const times: number[] = [];
    let got: number[] = [];
    for (let run = 0; run < 25; run++) {
      const t0 = performance.now();
      const p = parseQuery(q);
      got = p.ok ? recs.filter((_, i) => matches(p.node, haystacks[i])).map((r) => r.n) : [];
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    const same = got.length === want.length && got.every((n, i) => n === want[i]);
    check(same && want.length > 0, `"${q}" finds exactly the ${want.length} the independent filter finds`, `${got.length} found · median ${times[12].toFixed(2)} ms over 3,000`);
  }
  void has;

  console.log(failures === 0 ? '\ncandidate search check: all checks passed' : `\ncandidate search check: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
