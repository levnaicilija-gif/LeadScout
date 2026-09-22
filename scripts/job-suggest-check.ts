/**
 * What a job is scored AGAINST — the one place a suggestion can invent a requirement.
 *
 *   npx tsx scripts/job-suggest-check.ts
 *
 * Pure: no database, no network, no model call. In the release gate.
 *
 * WHAT IS AT STAKE, and why a window rather than the whole page. 0 of 55 open postings carry a
 * stored description, so every suggestion re-reads the advert from source_url. A re-read lands on
 * the advert most of the time and on the board's LISTING page the rest of it — and a listing page
 * carries twenty other companies' requirements. scoreAgainstJob asks for "one reason per requirement
 * the job actually states"; fed a listing it would state somebody else's, with a real quote behind
 * it, which is the worst version of the invented-requirement failure because it looks sourced.
 *
 * So the fixture below is built so that a resolver which trusts any page that loads FAILS: the
 * listing page is perfectly readable, long, and full of requirements — just not this advert's.
 */
import { windowAroundTitle, jobTextResolver, type JobSource } from '../src/lib/job-suggest';

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

const ROLE = 'Sveiser til rørarbeid';
/** The advert's own page: the title is on it, and so are its requirements. */
const ADVERT = `Om stillingen ${ROLE}. Vi søker en erfaren sveiser. Krav: ISO 9606-1 141 P BW, minst tre års erfaring, norsk eller engelsk. Rotasjon 14/14. ${'Vi tilbyr konkurransedyktige betingelser og et godt arbeidsmiljø. '.repeat(12)}`;
/** The board's listing page: readable, long, full of requirements — none of them this advert's. */
const LISTING = `Ledige stillinger. Elektriker i Bergen — krav: fagbrev og FSE-kurs. Stillasbygger — krav: CISRS Advanced. NDT-tekniker — krav: PCN Level 2 og CSWIP 3.1. ${'Se alle stillinger hos våre samarbeidspartnere. '.repeat(40)}`;

console.log('--- the window proves the page is the right page ---');
check(windowAroundTitle(ADVERT, ROLE) !== null, 'the advert\'s own page carries its title, so it is used');
check(windowAroundTitle(LISTING, ROLE) === null, 'a listing page that never names this advert is REFUSED, however readable it is');
check(windowAroundTitle(ADVERT, 'SVEISER TIL RØRARBEID') !== null, 'the match ignores case');
check(windowAroundTitle(`Om stillingen\n\n  ${ROLE}\n`, ROLE) !== null, 'and runs of whitespace');
check(windowAroundTitle(ADVERT, '') === null, 'an advert with no title of its own cannot prove any page');
const huge = `${'x '.repeat(20000)}${ROLE} krav: ISO 9606${' y'.repeat(20000)}`;
const win = windowAroundTitle(huge, ROLE) ?? '';
check(win.length <= 6000, 'a huge page is trimmed rather than sent whole', `${win.length} chars`);
check(win.toLowerCase().includes(ROLE.toLowerCase()), 'and the trim keeps the title itself');
check(win.includes('ISO 9606'), 'and what the advert says just after it', win.slice(win.indexOf('ISO') - 10, win.indexOf('ISO') + 12));

console.log('\n--- which text a posting is scored against, and it always says which ---');
const SOURCES: Record<string, JobSource> = {
  stored:    { role: ROLE, description: `Full stored description. ${'Krav: ISO 9606-1. '.repeat(20)}`, sourceUrl: 'https://example.test/a' },
  thin:      { role: ROLE, description: 'Sveiser.', sourceUrl: 'https://example.test/advert' },
  advert:    { role: ROLE, sourceUrl: 'https://example.test/advert' },
  listing:   { role: ROLE, sourceUrl: 'https://example.test/listing' },
  dead:      { role: ROLE, sourceUrl: 'https://example.test/404' },
  throws:    { role: ROLE, sourceUrl: 'https://example.test/boom' },
  nourl:     { role: ROLE },
  nothing:   { role: '' },
};
let fetched: string[] = [];
const resolve = jobTextResolver(
  (id) => SOURCES[id],
  async (url) => {
    fetched.push(url);
    if (url.endsWith('/boom')) throw new Error('connect timeout');
    if (url.endsWith('/404')) return { text: '', status: 'not_found' };
    if (url.endsWith('/listing')) return { text: LISTING, status: 'live' };
    return { text: ADVERT, status: 'live' };
  },
);
const at = async (id: string) => await resolve({ job: { id } });

(async () => {
  const stored = await at('stored');
  check(stored?.from === 'description', 'a stored description is used as it stands', stored?.from);
  check(fetched.length === 0, 'and the advert is NOT re-read when one is already on file — the free path is still a fetch');

  const advert = await at('advert');
  check(advert?.from === 'fetched', 'with no description the advert is re-read', advert?.from);
  check((advert?.chars ?? 0) > 200, 'and there is something to judge', `${advert?.chars} chars`);
  check(/ISO 9606/.test(advert?.text ?? ''), 'including what the advert actually asks for');

  // The assertion this file exists for.
  const listing = await at('listing');
  check(listing?.from === 'title', 'a LISTING page is not scored against — it falls back to the title', listing?.from);
  check(listing?.text === ROLE, 'and the text is the title alone', listing?.text);
  check(!/CISRS|PCN|FSE/.test(listing?.text ?? ''), 'so another advert\'s requirements are never handed to the model', listing?.text);

  const thin = await at('thin');
  check(thin?.from === 'fetched', 'a description too short to judge is not trusted just for being stored', thin?.from);

  const dead = await at('dead');
  check(dead?.from === 'title', 'a page that does not load falls back to the title rather than failing the job', dead?.from);
  const threw = await at('throws');
  check(threw?.from === 'title', 'and so does a fetch that throws — the connect fault must not lose a suggestion', threw?.from);
  const nourl = await at('nourl');
  check(nourl?.from === 'title', 'a posting with no source_url still offers its title', nourl?.from);

  check(await at('nothing') === null, 'a posting with no title and nothing else is never scored at all');
  check(await at('missing-id') === null, 'and neither is an id the caller cannot describe');

  console.log(failures ? `\njob suggest: ${failures} FAILED` : '\njob suggest: all checks passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
