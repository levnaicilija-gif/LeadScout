/**
 * What a source's index page actually offers, so a link rule is written against the site
 * rather than guessed. Prints how the page was read, what articleLinks() accepts today, and a
 * sample of the paths it rejected, grouped by shape.
 *
 *   npx tsx --env-file=.env.local scripts/probe-links.ts https://www.fluor.com/newsroom
 */
import { fetchPage, articleLinks } from '../src/lib/fetch-page';

(async () => {
  for (const url of process.argv.slice(2)) {
    const page = await fetchPage(url);
    console.log(`\n=== ${url}`);
    console.log(`    read via ${page.via}, status ${page.status}${page.note ? ` — ${page.note}` : ''}, ${page.links.length} hrefs, ${page.text.length} chars`);
    const accepted = articleLinks(page, 15);
    console.log(`    articleLinks accepts ${accepted.length}`);
    accepted.slice(0, 6).forEach((a) => console.log(`      + ${a}`));

    let origin = '';
    try { origin = new URL(page.url).origin; } catch { /* not a URL we can group by */ }
    const shapes = new Map<string, string[]>();
    for (const l of page.links) {
      try {
        const u = new URL(l);
        if (u.origin !== origin) continue;
        // Group by the first two path segments: that is where a site's article prefix lives.
        const seg = u.pathname.split('/').filter(Boolean);
        const key = '/' + seg.slice(0, 2).join('/');
        (shapes.get(key) ?? shapes.set(key, []).get(key)!).push(u.pathname);
      } catch { /* skip */ }
    }
    console.log('    paths on the page, by prefix:');
    [...shapes.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12)
      .forEach(([k, v]) => console.log(`      ${String(v.length).padStart(3)}  ${k}   e.g. ${v[0]}`));
  }
})();
