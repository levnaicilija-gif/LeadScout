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
