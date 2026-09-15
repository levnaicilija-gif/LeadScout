/** What the drawer says about a company's website: npx tsx scripts/site-trust-check.ts */
import { siteTrust } from '../src/lib/site-trust';

let failed = 0;
const check = (ok: boolean, what: string, got?: unknown) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` — ${JSON.stringify(got)}`}`); if (!ok) failed++; };

// ALLEZ ENERGIES after 0033: not printed, own site.
let t = siteTrust({ name: 'ALLEZ ENERGIES', domain: 'allez.fr', country: 'FR', domain_source: 'web search', domain_address_check: 'not_printed', domain_checked_address: '16260 Chasseneuil-Sur-Bonnieure', domain_scope: 'own' });
check(!!t && !t.confirmed && t.rowNote === 'unconfirmed' && t.lines.length === 1 && t.lines[0].tone === 'warn' && /does not print the award notice's address \(16260 Chasseneuil-Sur-Bonnieure\)/.test(t.lines[0].text), 'ALLEZ ENERGIES reads "Not confirmed", with the address, as a warning', t);
// Before 0033: the same from batch 1's source text.
t = siteTrust({ name: 'ALLEZ ENERGIES', domain: 'allez.fr', country: 'FR', source: 'web search · address not printed on the site' });
check(!!t && t.check === 'not_printed' && !t.confirmed, 'before 0033 the check is read from the source text batch 1 wrote', t);
// COLAS FRANCE: the group rule on read, and not printed.
t = siteTrust({ name: 'COLAS FRANCE', domain: 'colas.com', country: 'FR', source: 'web search · address not printed on the site' });
check(!!t && t.scope === 'group' && t.rowNote === 'unconfirmed · group site' && t.lines[0].kind === 'scope' && /looks like the group's website, not COLAS FRANCE's own/.test(t.lines[0].text), 'COLAS FRANCE reads as the group\'s site first, then not confirmed', t);
// Aellia: a group site that prints the winner's address — confirmed, and still a group site.
t = siteTrust({ name: 'Aellia Belgium NV', domain: 'aellia.com', domain_address_check: 'printed', domain_checked_address: '2490 Balen', domain_scope: 'group', domain_scope_reason: 'the winner is the Belgium entity' });
check(!!t && t.confirmed && t.scope === 'group' && t.rowNote === 'group site' && t.lines.some((l) => l.tone === 'ok' && /prints the award notice's address \(2490 Balen\)/.test(l.text)), 'Aellia: confirmed by address and still flagged as a group site', t);
// A website the award notice printed itself.
t = siteTrust({ name: 'Heinen Gruppe Gerüstbau GmbH & Co. KG', domain: 'heinen-gruppe.de', source: 'ted award notice' });
check(!!t && t.check === 'from_notice' && t.confirmed && t.rowNote === null, 'a website given in the award notice is confirmed by the notice', t);
// A domain from somewhere else, never checked: nothing is claimed either way.
t = siteTrust({ name: 'Karstensens Skibsværft', domain: 'karstensens.dk', source: 'WindEurope attendee list' });
check(!!t && t.check === null && !t.confirmed && t.lines.length === 0 && t.rowNote === null, 'a legacy domain with no check says nothing', t);
check(siteTrust({ name: 'No Site AS', domain: null }) === null, 'no website, no trust line');
// 0033's stored scope wins over the rule on read.
t = siteTrust({ name: 'COLAS FRANCE', domain: 'colas.com', domain_address_check: 'printed', domain_scope: 'own' });
check(!!t && t.scope === 'own' && t.confirmed, 'a scope stored by 0033 is used as stored', t);

console.log(failed ? `\n${failed} failed` : '\nsite trust: all checks passed');
process.exitCode = failed ? 1 : 0;
