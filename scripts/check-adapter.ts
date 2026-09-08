/**
 * Live smoke-test for a verification adapter. Hits the real issuer register.
 *   npx tsx scripts/check-adapter.ts pcn --number 347534 --method Radiography
 *   npx tsx scripts/check-adapter.ts frosio --number 12345 --holder "A Name"
 * Prints the verdict and what was read from the page. Nothing is stored.
 */
import { ADAPTERS, runLookup } from '../src/lib/verify/adapters';

const [body, ...rest] = process.argv.slice(2);
const arg = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };

if (!body || !ADAPTERS[body]) {
  console.error(`usage: check-adapter <${Object.keys(ADAPTERS).join('|')}> [--number N] [--holder "Name"] [--method M] [--credentialUrl URL]`);
  process.exit(1);
}

runLookup(body, {
  number: arg('number'), holder: arg('holder'), method: arg('method'), level: arg('level'), credentialUrl: arg('credentialUrl'),
}).then((r) => {
  console.log(`adapter      ${ADAPTERS[body].name}`);
  console.log(`result       ${r.result}`);
  console.log(`checkedWhere ${r.checkedWhere}`);
  console.log(`checkedAt    ${r.checkedAt}`);
  console.log(`validUntil   ${r.validUntil ?? '-'}`);
  console.log(`holder       ${r.holderOnSource ?? '-'}`);
  console.log(`screenshot   ${r.screenshot ? `${r.screenshot.length} bytes` : '-'}`);
  console.log(`certificates ${r.certificates?.length ?? 0}`);
  for (const c of r.certificates ?? []) console.log(`  - ${c.method ?? '?'} L${c.level ?? '?'} ${c.number ?? '?'} issued ${c.issued ?? '?'} expires ${c.expiry ?? '?'}`);
  console.log(`notes        ${r.notes ?? '-'}`);
});
