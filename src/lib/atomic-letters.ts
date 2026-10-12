/**
 * Letters NFD cannot decompose, folded to the plain forms a domain or an event list actually uses.
 *
 * Folding accents by decomposing and dropping the combining marks works for ö, å, ñ and é — each is a base
 * letter plus a mark. Ø (U+00D8), Æ (U+00C6), ß, þ, ð, ł and the rest are ATOMIC letters with no canonical
 * decomposition, so they pass through such a fold untouched and "Ørsted" never meets "Orsted".
 *
 * One list for every comparison that needs it — `site-scope`'s brand test and `canonCompany` — because two
 * copies drift, and the drifted one is the one nobody reads. Lower case only: callers lower-case first.
 *
 * Imports nothing, so it is safe in a client bundle.
 */
const ATOMIC_LETTERS: [RegExp, string][] = [
  [/ø/g, 'o'], [/æ/g, 'ae'], [/œ/g, 'oe'], [/ß/g, 'ss'], [/þ/g, 'th'], [/ð/g, 'd'],
  [/ł/g, 'l'], [/đ/g, 'd'], [/ħ/g, 'h'], [/ŧ/g, 't'], [/ı/g, 'i'], [/ŋ/g, 'n'],
];

export const foldAtomicLetters = (s: string) => {
  let t = s;
  for (const [re, to] of ATOMIC_LETTERS) t = t.replace(re, to);
  return t;
};

/**
 * THE OTHER WAY A SITE SPELLS THE SAME LETTER (owner's decision 2026-10-12): as a DIGRAPH. Holbøll's site is
 * holboell.dk, Schüttler Gerüstbau's is schuettler-geruestbau.de, and the fold above turns those names into
 * "holboll" and "schuttler gerustbau", so the brand test called the company's own site unrelated. Measured that
 * day over 166 tender winners with a domain: 16 verdicts flip, every one German ü→ue.
 *
 * Applied BEFORE the NFD fold, because ä, ö, ü and å decompose and would lose the letter that says which digraph
 * to write. Lower case only, like the fold. Used ONLY by `site-scope`, as a SECOND spelling beside the folded
 * one — either may fit. `canonCompany` deliberately does NOT use it: company identity keeps one canonical form,
 * and two spellings there would merge rows rather than accept a website.
 *
 * It only ever REPLACES a letter that is there; it never invents one. "Holboll" (no ø) is not "holboell", and
 * "værft" is still not "verft" — a different word is not a different encoding.
 */
const DIGRAPH_LETTERS: [RegExp, string][] = [
  [/ø/g, 'oe'], [/ö/g, 'oe'], [/æ/g, 'ae'], [/ä/g, 'ae'], [/å/g, 'aa'], [/ü/g, 'ue'], [/ß/g, 'ss'], [/œ/g, 'oe'],
];

export const toDigraphs = (s: string) => {
  let t = s.normalize('NFC');
  for (const [re, to] of DIGRAPH_LETTERS) t = t.replace(re, to);
  return t;
};
