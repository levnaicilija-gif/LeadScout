/**
 * Does the candidate's name appear anywhere in the client-facing PDF?
 *
 * Reads the real stored PDFs — not the inputs the renderer was handed — and looks in four
 * places a name can hide: the drawn text, the document information dictionary (Title, Author,
 * Subject, Creator, Producer), the storage path, and the file name the download is served
 * under. A name in the file properties is still a leak, and nothing else in the codebase reads
 * the rendered bytes.
 *
 * Three things had to be got right before the answer meant anything, and each of them silently
 * produced "clean" until it was:
 *   · the newline before `endstream` is optional, so a stricter regex matched no streams at all;
 *   · @react-pdf writes text as HEX runs inside TJ arrays, not as (literal) strings;
 *   · the Info dictionary holds indirect references, with the text in separate UTF-16BE objects.
 *
 * A file whose text cannot be read is reported as unreadable, never as clean.
 *
 *   npx tsx --env-file=.env.local scripts/pdf-name-audit.ts
 */
import zlib from 'node:zlib';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const PRINTABLE = /^[ -~ -ÿ]*$/;

const unescapePdf = (s: string) =>
  s.replace(/\\([nrtbf()\\])/g, (_, c) => (({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[c] ?? c))
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

/**
 * A hex run from a TJ array, as text. With a subset font these bytes can be glyph ids rather
 * than characters, so anything that does not decode to printable text is dropped rather than
 * passed on as though it were readable.
 */
function fromHex(hex: string): string {
  const bytes = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
  const latin = bytes.toString('latin1');
  if (PRINTABLE.test(latin)) return latin;
  // swap16 throws on an odd length, and most runs here are one or two bytes.
  if (bytes.length % 2) return '';
  const utf16 = Buffer.from(bytes).swap16().toString('utf16le');
  return PRINTABLE.test(utf16) ? utf16 : '';
}

/** Literal strings drawn on the page, from every stream that inflates. */
function drawnText(pdf: Buffer): string {
  const out: string[] = [];
  const raw = pdf.toString('latin1');

  for (const m of raw.matchAll(/stream\r?\n?([\s\S]*?)endstream/g)) {
    const bytes = Buffer.from(m[1], 'latin1');
    let text = '';
    try { text = zlib.inflateSync(bytes).toString('latin1'); }
    catch { try { text = zlib.inflateRawSync(bytes).toString('latin1'); } catch { text = bytes.toString('latin1'); } }

    for (const t of text.matchAll(/\(((?:\\.|[^\\()])*)\)\s*(?:Tj|TJ|')/g)) out.push(unescapePdf(t[1]));
    for (const arr of text.matchAll(/\[([^\][]*)\]\s*TJ/g)) {
      for (const t of arr[1].matchAll(/\(((?:\\.|[^\\()])*)\)/g)) out.push(unescapePdf(t[1]));
      for (const h of arr[1].matchAll(/<([0-9A-Fa-f]+)>/g)) out.push(fromHex(h[1]));
    }
    for (const h of text.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(fromHex(h[1]));
  }
  return out.join(' ');
}

/** Title / Author / Subject / Creator / Producer, inline, hex or by indirect reference. */
function metadata(pdf: Buffer): Record<string, string> {
  const raw = pdf.toString('latin1');
  const out: Record<string, string> = {};
  const BOM = String.fromCharCode(0xfe, 0xff);

  const decode = (s: string) =>
    (s.startsWith(BOM) ? Buffer.from(s.slice(2), 'latin1').swap16().toString('utf16le') : unescapePdf(s));

  for (const key of ['Title', 'Author', 'Subject', 'Creator', 'Producer', 'Keywords']) {
    const inline = raw.match(new RegExp(`/${key}\\s*\\(((?:\\\\.|[^\\\\()])*)\\)`));
    if (inline) { out[key] = decode(inline[1]); continue; }

    const hex = raw.match(new RegExp(`/${key}\\s*<([0-9A-Fa-f\\s]+)>`));
    if (hex) { out[key] = Buffer.from(hex[1].replace(/\s/g, ''), 'hex').swap16().toString('utf16le'); continue; }

    const ref = raw.match(new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`));
    if (!ref) continue;
    const obj = raw.match(new RegExp(`(?:^|[^0-9])${ref[1]}\\s+0\\s+obj\\s*\\(((?:\\\\.|[^\\\\()])*)\\)`));
    if (obj) out[key] = decode(obj[1]);
  }
  return out;
}

/** Name parts worth searching for — initials and very short words match too much. */
const partsOf = (name: string) =>
  name.split(/[\s,]+/).map((w) => w.replace(/[^\p{L}-]/gu, '')).filter((w) => w.length > 2);

(async () => {
  const { data: cands } = await db.from('candidates').select('id, reference_code, full_name');
  if (!cands?.length) { console.log('no candidates on file'); return; }

  let leaks = 0;
  let audited = 0;

  // Every version, not just the newest. An older client PDF is still a downloadable object with
  // a signed URL somebody may hold, so auditing only the latest would leave real files unchecked.
  const { data: allCvs } = await db.from('anonymized_cvs')
    .select('candidate_id, storage_path, pii_check_passed, version, generated_at')
    .order('generated_at', { ascending: false });

  const pairs = cands.flatMap((c) => {
    const rows = (allCvs ?? []).filter((r) => r.candidate_id === c.id);
    return rows.length ? rows.map((cv) => ({ c, cv })) : [{ c, cv: null as any }];
  });

  for (const { c, cv } of pairs) {
    console.log(`\n${'='.repeat(74)}\n${c.reference_code}${cv?.version ? ` v${cv.version}` : ''} · internal name: ${JSON.stringify(c.full_name)}`);
    if (!cv?.storage_path) {
      console.log(cv
        ? `  version ${cv.version} wrote no file${cv.pii_check_passed ? '' : ' — it did not pass the PII check, which is the gate working'}`
        : '  no client PDF on file — nothing to audit');
      continue;
    }
    if (!cv.pii_check_passed) console.log('  (this version did not pass the PII check)');

    const { data: file, error } = await db.storage.from('pdfs').download(cv.storage_path);
    if (error || !file) { console.log(`  could not download: ${error?.message}`); leaks++; continue; }
    const pdf = Buffer.from(await file.arrayBuffer());

    const text = drawnText(pdf);
    const meta = metadata(pdf);
    const served = `${c.reference_code}.pdf`;

    console.log(`  stored at        : ${cv.storage_path}`);
    console.log(`  served as        : ${served}`);
    for (const [k, v] of Object.entries(meta)) console.log(`  ${k.padEnd(17)}: ${JSON.stringify(v)}`);
    console.log(`  drawn text       : ${text.length} characters`);

    // A PDF with visible pages always yields text. Zero means the reading failed, and a failed
    // reading must never be reported as an absence of names.
    if (text.length < 40) {
      console.log(`  UNREADABLE — only ${text.length} characters came out of the content streams.`);
      console.log('  Not reporting this file as clean: the extractor failed, which is not the same as no name being there.');
      leaks++;
      continue;
    }
    if (!Object.keys(meta).length) {
      console.log('  UNREADABLE — no document properties could be read, so they cannot be cleared.');
      leaks++;
      continue;
    }

    audited++;
    const parts = partsOf(c.full_name ?? '');
    let clean = true;
    for (const [where, hay] of [
      ['drawn text', text],
      ['document properties', Object.values(meta).join(' ')],
      ['storage path', cv.storage_path],
      ['download filename', served],
    ] as [string, string][]) {
      for (const p of parts) {
        if (new RegExp(`\\b${p}\\b`, 'i').test(hay)) {
          console.log(`  LEAK  "${p}" appears in the ${where}`);
          clean = false; leaks++;
        }
      }
    }
    if (clean) console.log(`  clean — no part of the name (${parts.join(', ') || 'none long enough to search'}) is in the text, the properties, the path or the filename`);
  }

  console.log(`\n${audited} PDF(s) fully audited · ${leaks === 0 ? 'no name leaks found' : `${leaks} problem(s)`}`);
  process.exit(leaks === 0 ? 0 : 1);
})();
