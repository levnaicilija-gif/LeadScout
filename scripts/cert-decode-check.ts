/**
 * Prove the ISO 9606 decoder against real designations.
 *
 * Every case here is a string that actually arrived on a document, plus a few written to pin
 * down the range rules. The decoder is pure code with no model call, so this is a test in the
 * ordinary sense: same input, same output, every time.
 *
 *   npx tsx scripts/cert-decode-check.ts
 *   npx tsx --env-file=.env.local scripts/cert-decode-check.ts --live   also decode what is on file
 */
import { decodeIso9606 } from '../src/lib/certs/iso9606';

type Case = { name: string; raw: string; expect: string[] };

const CASES: Case[] = [
  {
    name: 'Bureau Veritas · LICA IONEL · 1073GLZ25',
    raw: 'EN ISO 9606-1: (138+136) T BW 1.2 FM1 (M+P) s25(12+13) D219.1 PH-L045 ssnb',
    expect: [
      '138 — MAG welding with metal-cored wire',
      '136 — MAG welding with flux-cored wire',
      'tube or pipe',
      'butt weld',
      'group 1.2',
      'FM1',
      'H-L045',
      '109.6 mm outside diameter and above',
      'no backing',
    ],
  },
  {
    name: 'TÜV SÜD · PEPLIŃSKI · 0036/PL/S-24/06704',
    raw: 'ISO 9606-1 138/136 T BW FM3 M/B s12/13 D114 H-L045 ss nb',
    expect: ['138', '136', 'tube or pipe', 'H-L045', '57 mm outside diameter and above'],
  },
  {
    name: 'plate, TIG, thin wall',
    raw: 'ISO 9606-1 141 P BW FM1 S t3 PF ss nb',
    expect: ['141 — TIG', 'plate or sheet', '3 mm to 6 mm', 'PF'],
  },
  {
    name: 'MMA basic, vertical down',
    raw: 'ISO 9606-1 111 T BW 1.1 FM1 B t8 D60 PJ mb ml',
    expect: ['111 — manual metal arc', 'B — basic covering', 'PJ', '3 mm to 16 mm', '30 mm outside diameter and above'],
  },
  {
    name: 'aluminium is a different standard',
    raw: 'ISO 9606-2 131 P BW 22 S t6 PA ss nb',
    expect: ['ISO 9606-2', '131 — MIG', 'group 22'],
  },
];

let failures = 0;

function show(title: string, d: ReturnType<typeof decodeIso9606>) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
  if (!d) { console.log('  NOT DECODED'); return; }
  console.log(`  ${d.standard} — ${d.material}`);
  console.log(`  raw: ${d.raw}\n`);
  console.log('  What the code says');
  for (const l of d.says) {
    console.log(`    ${l.label.padEnd(13)} ${l.token.padEnd(12)} ${l.says}`);
    if (l.range) console.log(`    ${' '.repeat(13)} ${' '.repeat(12)} → ${l.range}`);
  }
  console.log('\n  What this welder can do');
  d.can.forEach((c) => console.log(`    · ${c}`));
  console.log('\n  Does not cover');
  d.cannot.forEach((c) => console.log(`    · ${c}`));
  console.log('\n  Fits our jobs');
  d.fits.forEach((c) => console.log(`    · ${c}`));
  if (d.undecoded.length) console.log(`\n  Read but not decoded: ${d.undecoded.join(', ')}`);
}

for (const c of CASES) {
  const d = decodeIso9606(c.raw);
  show(c.name, d);
  const flat = JSON.stringify(d ?? {});
  const missed = c.expect.filter((e) => !flat.includes(e));
  if (missed.length) { failures++; console.log(`\n  MISSING: ${missed.join(' | ')}`); }
}

if (process.argv.includes('--live')) {
  (async () => {
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const { data } = await db.from('documents').select('extracted').eq('type', 'certificate').eq('cert_body', 'iso9606');
    for (const d of data ?? []) {
      const e = d.extracted as any;
      show(`ON FILE · ${e?.holder ?? '—'} · ${e?.issuer ?? '—'} · ${e?.number ?? '—'}`, decodeIso9606(e?.scope ?? '', { position: e?.position, process: e?.process }));
    }
    console.log(failures ? `\n${failures} case(s) missing expected content` : '\nall cases decoded as expected');
    process.exit(failures ? 1 : 0);
  })();
} else {
  console.log(failures ? `\n${failures} case(s) missing expected content` : '\nall cases decoded as expected');
  process.exit(failures ? 1 : 0);
}
