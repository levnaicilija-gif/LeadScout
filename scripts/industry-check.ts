/**
 * Item 18's industry classifier, proved offline on text shaped like what is stored.
 *
 *   npx tsx scripts/industry-check.ts
 */
import { classifyAward, classifyNews, classifyCompany, cpvCodesIn, quotedIn, FOLLOW_OPTIONS, repeatedSentences } from '../src/lib/industry';

/** A site's own line, printed on every story it publishes, is not the story. Called below, once check exists. */
function siteChromeChecks() {
  const teaser = 'Intelligent and data-driven solutions that improve performance and optimize the cooling of every data center we design for our many clients.';
  const stories = [
    { url: 'https://www.example-engineering.test/news/rail', text: `${teaser} The company has been appointed to deliver the new high speed rail line between the two regional cities this year.` },
    { url: 'https://www.example-engineering.test/news/road', text: `${teaser} The company will design the upgrade of the coastal highway and its bridges over the next three years.` },
  ];
  const chrome = repeatedSentences(stories);
  const rail = classifyNews({ title: 'Rail appointment', text: stories[0].text, url: stories[0].url }, chrome);
  check(rail.industries.join() === 'infrastructure_energy_services', 'a line the site prints on two of its stories tags neither ("…every data center we design…"); the story gives Infrastructure', rail);
  const alone = classifyNews({ title: 'Rail appointment', text: stories[0].text, url: stories[0].url });
  check(alone.industries.includes('data_centers'), 'without the site\'s other stories the same line would have tagged Data Centers — the rule is what removes it', alone);
}

let failed = 0;
const check = (ok: boolean, what: string, detail?: unknown) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${what}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};
const notice = (main: string, all: string, body = '') => `Award notice\n${body}\nMain CPV code: ${main}\nAll CPV codes: ${all}\n`;

// Award notices: confirmed codes only.
check(cpvCodesIn(notice('45262100', '45262100, 45000000')).join() === '45262100,45000000', 'CPV codes are read off the Main and All lines');
check(classifyAward(notice('45262100', '45262100')).industries.join() === 'other', 'a scaffolding award names no industry (a trade, not an industry)');
check(classifyAward(notice('45231400', '45231400')).industries.join() === 'grid', 'power-line construction is Grid');
check(classifyAward(notice('50241000', '50241000')).industries.join() === 'fabrication_heavy_industry', 'ship repair is Fabrication Yards & Heavy Industry');
check(classifyAward(notice('45232141', '45232141')).industries.join() === 'other', 'heating works (a sibling of district heating) is not district heating — item 12\'s rule');
check(classifyAward(notice('45251160', '45251160', 'Installation of an offshore wind farm')).industries.join() === 'offshore_wind', 'a wind code says offshore only when the notice does');
check(classifyAward(notice('45251160', '45251160', 'Wind farm works')).industries.join() === 'renewable_general', 'a wind code with no offshore or onshore word is Renewable general');
check(classifyAward(notice('45000000', '45000000', 'Construction of an offshore wind farm')).industries.join() === 'other', 'an award is classified by its codes only, never its words');

// News: prose only.
const nav = 'Direct naar inhoud Offshore-Energy.biz offshoreWIND.biz DredgingToday.com NavalToday.com Exhibition and Conference Advertising Green MarineHydrogen';
const pipeStory = classifyNews({ title: 'Fulkrum steps up Norwegian offshore oil & gas presence with Vår Energi deal', text: `${nav}\nFulkrum has been awarded an inspection services contract by Vår Energi for the Ophelia, Gjøa Nord and Cerisa subsea developments in the Gjøa area.` });
check(pipeStory.industries.join() === 'oil_gas', 'a site menu naming offshoreWIND and Hydrogen tags nothing; the story\'s own words give Oil & Gas', pipeStory);
check(classifyNews({ title: 'Vattenfall awarded Hesselø and North Sea I Mid offshore wind projects in Danish tender' }).industries.join() === 'offshore_wind', 'an offshore wind award is Offshore Wind');
const rail = classifyNews({
  title: 'Contractor awarded delivery partner role for high speed rail',
  text: 'The contractor has been selected as delivery partner for the new high speed rail line between the two cities in the region. '
    + 'About the contractor: the contractor is a global engineering company working in LNG, mining, refineries, data centers and life sciences across the world today.',
});
check(rail.industries.join() === 'infrastructure_energy_services', 'a company\'s paragraph about itself ("a global engineering company working in LNG, mining…") tags nothing; the story gives Infrastructure', rail);
const late = classifyNews({
  title: 'Contractor wins road contract',
  text: Array.from({ length: 12 }, (_, n) => `This is sentence number ${n + 1} of the story about the road improvement project and its many details for readers.`).join(' ')
    + ' The group also has a long history in offshore oil and gas projects across many basins worldwide.',
});
check(!late.industries.includes('oil_gas'), 'a word past the opening ten sentences of a story does not tag it', late);
const ccs = classifyNews({ title: 'Aker Solutions wins FEED contract for CO₂ terminal in Lithuania', projectName: 'CO₂ transshipment terminal infrastructure project' });
check(ccs.industries.includes('ccs'), 'a CO₂ terminal is Carbon Capture & Storage (the subscript two is read)', ccs);
check(classifyNews({ title: 'Worley awarded BCEI contracts supporting US data center expansion' }).industries.includes('data_centers'), 'data center work is Data Centers');
check(classifyNews({ title: 'BHP awards Worley contracts for Copper South Australia projects', projectName: 'Copper South Australia growth projects' }).industries.join() === 'other'
  || classifyNews({ title: 'BHP awards Worley contracts for Copper South Australia projects', projectName: 'Copper South Australia growth projects' }).industries.includes('mining_metals') === false,
  'the word "copper" on its own is not a mine');
check(classifyNews({ title: 'Palmer Wind Farm owner\'s engineer', text: 'Jacobs has been appointed owner\'s engineer for the Palmer wind farm project being developed in South Australia by the developer.' }).industries.join() === 'renewable_general',
  'a wind farm that does not say offshore or onshore is Renewable general, not a guessed kind');
const tussa = classifyNews({ title: 'Aker Solutions secures contract with Tussa Energi for Tussa II hydropower plant' });
check(tussa.industries.join() === 'renewable_general', 'a hydropower plant is Renewable general', tussa);
check(classifyNews({ title: 'Fincantieri and Viking sign contracts for two new ocean ships' }).industries.join() === 'fabrication_heavy_industry', 'new ocean ships are yard work');
check(classifyNews({ title: 'Company news', text: 'The company reported quarterly results and thanked its shareholders for their continued support this year.' }).industries.join() === 'other', 'a story naming no industry is Other / Uncategorized');
const both = classifyNews({ title: 'Contractor wins offshore wind and export cable work', text: 'The contractor will install the export cables and the substation for the offshore wind farm under the new agreement signed today.' });
check(both.industries.includes('offshore_wind') && both.industries.includes('grid'), 'one story can be two industries', both);
check(!both.industries.includes('renewable_general'), 'Renewable general drops out once a specific renewable category is named');

// Companies: advert titles and quoted page words only.
check(classifyCompany({ postingTitles: ['Skibsbyggere / Smede til Reparation'] }).industries.join() === 'fabrication_heavy_industry', 'a Danish shipbuilder advert is yard work');
check(classifyCompany({ postingTitles: ['QC-inspektører (FROSIO isolasjon/overflate)'] }).industries.join() === 'coatings_corrosion', 'a FROSIO inspector advert is Coatings & Corrosion');
check(classifyCompany({ postingTitles: ['Service Technician (m/f/d) for Wind Turbines HV in Großweitzschen'] }).industries.join() === 'renewable_general', 'wind turbine service with no offshore or onshore word is Renewable general');
check(quotedIn('Vestas is a manufacturer that employs trades like \'Wind Site Technician\' and says "offshore wind service"').join('|') === 'Wind Site Technician|offshore wind service', 'only quoted words are taken from a model-written evidence summary');
check(classifyCompany({ postingTitles: ['Fagingeniør Mekanisk'], employerEvidence: 'Equinor is an oil and gas company; the page states \'Do you want to contribute to the energy transition\'' }).industries.join() === 'other',
  'the unquoted summary ("an oil and gas company") is not evidence, and "energy transition" on its own names no industry');

// Following.
const wind = FOLLOW_OPTIONS.find((o) => o.id === 'wind');
check(!!wind && wind.industries.join() === 'offshore_wind,onshore_wind' && !FOLLOW_OPTIONS.some((o) => o.id === 'offshore_wind' || o.id === 'onshore_wind') && FOLLOW_OPTIONS.length === 16,
  'following Wind follows Offshore and Onshore Wind; the two are not offered separately; 16 choices');

siteChromeChecks();

console.log(failed ? `industry check: ${failed} failed` : 'industry check: all passed');
process.exit(failed ? 1 : 0);
