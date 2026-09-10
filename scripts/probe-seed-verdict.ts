/**
 * What the seeder's classifier actually says about a domain. The v1 audit showed 43 domains
 * that load fine and still never reached the companies table, including names like Balfour
 * Beatty that plainly do employ trades — this prints the verdict so the cause is visible.
 *
 *   npx tsx --env-file=.env.local scripts/probe-seed-verdict.ts balfourbeatty.com democo.be
 */
import * as cheerio from 'cheerio';
import { httpGet } from '../src/lib/http';
import { claude, MODEL_CLASSIFY } from '../src/lib/ai/claude';

const SYSTEM = `You are reading a company's own homepage to identify it.

Return JSON only:
{"company":"the company's own name as printed on the page","sector":"offshore_wind | shipyard | oil_gas | epc | industrial | marine_contractor | om_service | irrelevant","country":"ISO-3166 alpha-2 of where it is based","is_agency":true|false}

Rules:
- company is the name the site gives itself, copied from the page — not guessed from the domain.
- If the page is parked, an error, a domain-for-sale notice, a directory or a link farm, return {"company":null}.
- is_agency is true for a staffing, recruitment, manpower or crewing business — those employ nobody directly and are not wanted here.
- sector describes what the company DOES. irrelevant covers banks, investors, law firms, consultancies, software, research, media, associations and public bodies.
- Omit country if the page does not say where the company is based.`;

(async () => {
  for (const domain of process.argv.slice(2)) {
    const res = await httpGet(`https://${domain}`, {}, 20000);
    if (!res.ok) { console.log(`${domain}: could not fetch — ${res.error ?? `HTTP ${res.status}`}\n`); continue; }
    const $ = cheerio.load(res.body);
    $('script, style, noscript').remove();
    const evidence = [
      `TITLE: ${$('title').first().text().trim()}`,
      `SITE NAME: ${$('meta[property="og:site_name"]').attr('content') ?? ''}`,
      `DESCRIPTION: ${$('meta[name="description"]').attr('content') ?? ''}`,
      `TEXT: ${$('body').text().replace(/\s+/g, ' ').trim().slice(0, 1500)}`,
      `FOOTER: ${$('footer').text().replace(/\s+/g, ' ').trim().slice(0, 400)}`,
    ].join('\n');
    const ai = await claude.messages.create({
      model: MODEL_CLASSIFY, max_tokens: 300, system: SYSTEM,
      messages: [{ role: 'user', content: `Domain: ${domain}\n\n${evidence}` }],
    });
    const text = ai.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
    console.log(`${domain}: ${text.replace(/\s+/g, ' ').trim()}`);
    console.log(`   body text seen: ${$('body').text().replace(/\s+/g, ' ').trim().slice(0, 160)}\n`);
  }
})();
