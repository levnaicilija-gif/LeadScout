/**
 * Boolean search over the candidate pool (item 24). Pure: parse a query once, test it against each candidate's text.
 *
 *   welder AND (norway OR denmark) AND NOT "level 1"
 *   aibel placed            — adjacent terms are AND
 *   #4                      — a candidate number is a term like any other
 *
 * Operators are the words AND, OR, NOT in capitals, and parentheses; NOT binds tightest, then AND, then OR. A term or a
 * "quoted phrase" matches when it appears anywhere in the candidate's searchable text, ignoring case and accents
 * ("Jovanović" is found by "jovanovic"). Lower-case "and", "or", "not" are ordinary words, so a note saying "not
 * available" can be searched for. A query that cannot be read — an unclosed parenthesis, an operator with nothing after
 * it — returns an error that says where, never an empty result that looks like "nobody matches".
 */
export type Node =
  | { kind: 'term'; text: string }
  | { kind: 'not'; node: Node }
  | { kind: 'and' | 'or'; left: Node; right: Node };

export type Parsed = { ok: true; node: Node | null } | { ok: false; error: string };

/**
 * Letters Unicode does not split into a base letter and an accent, so NFD alone leaves them: "Ørsted" stayed "ørsted" and
 * the search "orsted" found none of the candidates sent to Ørsted (candidate-search-check, 2026-09-15). The pool's names
 * are Nordic, Polish and Serbian, so these are spelled out.
 */
const LETTERS: Record<string, string> = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', þ: 'th', ð: 'd', ı: 'i' };

/** Lower case, accents removed, whitespace collapsed — the one normal form for both the query and the text. */
export const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[øæœßłđþðı]/g, (ch) => LETTERS[ch]).replace(/\s+/g, ' ').trim();

type Token = { t: 'lp' | 'rp' | 'and' | 'or' | 'not' | 'term'; text?: string; at: number };

function tokenize(q: string): Token[] | string {
  const out: Token[] = [];
  let i = 0;
  while (i < q.length) {
    const ch = q[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(') { out.push({ t: 'lp', at: i }); i++; continue; }
    if (ch === ')') { out.push({ t: 'rp', at: i }); i++; continue; }
    if (ch === '"') {
      const end = q.indexOf('"', i + 1);
      if (end < 0) return `the quote opened at character ${i + 1} is never closed`;
      const text = fold(q.slice(i + 1, end));
      if (text) out.push({ t: 'term', text, at: i });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < q.length && !/[\s()"]/.test(q[j])) j++;
    const word = q.slice(i, j);
    if (word === 'AND') out.push({ t: 'and', at: i });
    else if (word === 'OR') out.push({ t: 'or', at: i });
    else if (word === 'NOT') out.push({ t: 'not', at: i });
    else out.push({ t: 'term', text: fold(word), at: i });
    i = j;
  }
  return out;
}

export function parseQuery(q: string): Parsed {
  const tokens = tokenize(q ?? '');
  if (typeof tokens === 'string') return { ok: false, error: tokens };
  if (tokens.length === 0) return { ok: true, node: null };
  // A list the nested readers can close over: TypeScript does not carry the narrowing above into them.
  const list: Token[] = tokens;
  let pos = 0;
  const peek = () => list[pos];
  const where = (tk?: Token) => (tk ? `at character ${tk.at + 1}` : 'at the end');

  // or := and (OR and)* ; and := not ((AND)? not)* ; not := NOT not | primary ; primary := term | ( or )
  function parseOr(): Node | string {
    let left = parseAnd();
    if (typeof left === 'string') return left;
    while (peek()?.t === 'or') {
      const op = list[pos++];
      const right = parseAnd();
      // Nothing left to read after OR is OR's fault, and says so; any other problem is the right-hand side's own.
      if (typeof right === 'string') return right === 'nothing to search for' ? `OR ${where(op)} has nothing after it` : right;
      left = { kind: 'or', left, right };
    }
    return left;
  }
  function parseAnd(): Node | string {
    let left = parseNot();
    if (typeof left === 'string') return left;
    for (;;) {
      const tk = peek();
      if (tk?.t === 'and') {
        pos++;
        const right = parseNot();
        if (typeof right === 'string') return `AND ${where(tk)} has nothing after it`;
        left = { kind: 'and', left, right };
      } else if (tk && (tk.t === 'term' || tk.t === 'lp' || tk.t === 'not')) {
        const right = parseNot(); // adjacent terms are AND
        if (typeof right === 'string') return right;
        left = { kind: 'and', left, right };
      } else return left;
    }
  }
  function parseNot(): Node | string {
    const tk = peek();
    if (tk?.t === 'not') {
      pos++;
      const node = parseNot();
      if (typeof node === 'string') return `NOT ${where(tk)} has nothing after it`;
      return { kind: 'not', node };
    }
    return parsePrimary();
  }
  function parsePrimary(): Node | string {
    const tk = peek();
    if (!tk) return 'nothing to search for';
    if (tk.t === 'term') { pos++; return { kind: 'term', text: tk.text! }; }
    if (tk.t === 'lp') {
      pos++;
      if (peek()?.t === 'rp') return `the parentheses ${where(tk)} are empty`;
      const inner = parseOr();
      if (typeof inner === 'string') return inner;
      if (peek()?.t !== 'rp') return `the parenthesis opened ${where(tk)} is never closed`;
      pos++;
      return inner;
    }
    if (tk.t === 'rp') return `the closing parenthesis ${where(tk)} has no opening one`;
    return `${tk.t.toUpperCase()} ${where(tk)} has nothing before it`;
  }

  const node = parseOr();
  if (typeof node === 'string') return { ok: false, error: node };
  if (pos < list.length) {
    const tk = list[pos];
    return { ok: false, error: tk.t === 'rp' ? `the closing parenthesis ${where(tk)} has no opening one` : `could not read the search ${where(tk)}` };
  }
  return { ok: true, node };
}

/** Does this candidate's folded searchable text satisfy the query? An empty query matches everyone. */
export function matches(node: Node | null, haystack: string): boolean {
  if (!node) return true;
  switch (node.kind) {
    case 'term': return haystack.includes(node.text);
    case 'not': return !matches(node.node, haystack);
    case 'and': return matches(node.left, haystack) && matches(node.right, haystack);
    case 'or': return matches(node.left, haystack) || matches(node.right, haystack);
  }
}

/** The query read back in plain words, for the screen: "welder AND (norway OR denmark)". */
export function describe(node: Node | null): string {
  if (!node) return '';
  switch (node.kind) {
    case 'term': return /\s/.test(node.text) ? `"${node.text}"` : node.text;
    case 'not': return `NOT ${node.node.kind === 'term' ? describe(node.node) : `(${describe(node.node)})`}`;
    case 'and':
    case 'or': {
      const side = (n: Node) => (n.kind === 'or' && node.kind === 'and' ? `(${describe(n)})` : describe(n));
      return `${side(node.left)} ${node.kind.toUpperCase()} ${side(node.right)}`;
    }
  }
}
