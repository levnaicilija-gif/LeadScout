/**
 * Drive contact discovery to completion.
 *
 * The route does one timed pass and says how many companies are left; this calls it until none
 * are. That replaces the fire-and-forget self-chain, which on the first real run reported
 * "more: true" and then never fired, leaving nine of seventeen companies to be driven by hand.
 *
 *   npx tsx --env-file=.env.local scripts/run-hiring-contacts.ts
 *   npx tsx --env-file=.env.local scripts/run-hiring-contacts.ts --local
 *   npx tsx --env-file=.env.local scripts/run-hiring-contacts.ts --force   re-read everything
 */
const BASE = process.argv.includes('--local')
  ? 'http://localhost:3100'
  : process.env.SCREEN_BASE ?? 'https://leadscout-rfbt.vercel.app';
const force = process.argv.includes('--force');

type Pass = {
  checked: number; done: boolean; remaining: number; tookMs?: number;
  organisationPage?: { companiesChecked: number; companiesYielding: number; contactsFound: number };
  report?: any[]; error?: string; reason?: string;
};

(async () => {
  const totals = { checked: 0, postingContacts: 0, orgContacts: 0, orgYielding: 0, passes: 0 };

  for (let pass = 1; pass <= 12; pass++) {
    const res = await fetch(`${BASE}/api/jobs/hiring-contacts`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force }),
    });
    const j = (await res.json().catch(() => ({}))) as Pass;

    if (!res.ok || j.error) { console.error(`pass ${pass}: ${j.error ?? `HTTP ${res.status}`}`); process.exit(1); }

    totals.passes++;
    totals.checked += j.checked ?? 0;
    totals.postingContacts += (j.report ?? []).reduce((n, r) => n + (r.postingContacts ?? 0), 0);
    totals.orgContacts += j.organisationPage?.contactsFound ?? 0;
    totals.orgYielding += j.organisationPage?.companiesYielding ?? 0;

    console.log(`pass ${pass}: checked ${j.checked ?? 0}, ${j.remaining ?? 0} left${j.tookMs ? ` (${Math.round(j.tookMs / 1000)}s)` : ''}${j.reason ? ` — ${j.reason}` : ''}`);
    for (const r of j.report ?? []) {
      const bits = [
        r.postingContacts ? `${r.postingContacts} on adverts` : null,
        r.orgContacts ? `${r.orgContacts} on the organisation page` : null,
        r.switchboard ? 'switchboard' : null,
        r.general ? 'general email' : null,
        r.stopped ? `STOPPED: ${r.stopped}` : null,
        r.error ? `ERROR: ${r.error}` : null,
      ].filter(Boolean);
      console.log(`    ${String(r.company).padEnd(28)} ${bits.join(' · ') || 'nothing found'}`);
    }

    if (j.done || (j.remaining ?? 0) === 0) break;
  }

  console.log(`\n${totals.passes} pass${totals.passes === 1 ? '' : 'es'} · ${totals.checked} companies checked`);
  console.log(`posting contacts written : ${totals.postingContacts}`);
  console.log(`organisation page        : ${totals.orgContacts} contacts across ${totals.orgYielding} companies`);
})();
