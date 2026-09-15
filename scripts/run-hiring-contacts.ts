/**
 * Drive contact discovery to completion.
 *
 * The route does one timed pass and says how many companies are left; this calls it until none
 * are. That replaces the fire-and-forget self-chain, which on the first real run reported
 * "more: true" and then never fired, leaving nine of seventeen companies to be driven by hand.
 *
 *   npx tsx --env-file=.env.local scripts/run-hiring-contacts.ts [--scope all|hiring|wonwork] [--force] [--local]
 *
 * The route sits behind the cron secret (since 2026-09-15); this sends it. Item 21 added Won work's companies.
 */
const BASE = process.argv.includes('--local')
  ? 'http://localhost:3100'
  : process.env.SCREEN_BASE ?? 'https://leadscout-rfbt.vercel.app';
const force = process.argv.includes('--force');
const scopeAt = process.argv.indexOf('--scope');
const scope = scopeAt > 0 ? process.argv[scopeAt + 1] : 'all';

type Pass = {
  checked: number; done: boolean; remaining: number; tookMs?: number; skippedNoSite?: number;
  organisationPage?: { companiesChecked: number; companiesYielding: number; contactsFound: number };
  wonWork?: { companiesChecked: number; leadsCovered: number; quotedLookedFor: number; quotedGained: number };
  report?: any[]; error?: string; reason?: string;
};

(async () => {
  const totals = { checked: 0, postingContacts: 0, orgContacts: 0, orgYielding: 0, passes: 0, wonCompanies: 0, wonLeads: 0, quotedLookedFor: 0, quotedGained: 0, skippedNoSite: 0 };
  const seen = new Map<string, number>();

  for (let pass = 1; pass <= 12; pass++) {
    const res = await fetch(`${BASE}/api/jobs/hiring-contacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET ?? '' },
      body: JSON.stringify({ force, scope }),
    });
    const j = (await res.json().catch(() => ({}))) as Pass;

    if (!res.ok || j.error) { console.error(`pass ${pass}: ${j.error ?? `HTTP ${res.status}`}`); process.exit(1); }

    totals.passes++;
    totals.checked += j.checked ?? 0;
    totals.skippedNoSite = j.skippedNoSite ?? totals.skippedNoSite;
    totals.postingContacts += (j.report ?? []).reduce((n, r) => n + (r.postingContacts ?? 0), 0);
    totals.orgContacts += j.organisationPage?.contactsFound ?? 0;
    totals.orgYielding += j.organisationPage?.companiesYielding ?? 0;
    totals.wonCompanies += j.wonWork?.companiesChecked ?? 0;
    totals.wonLeads += j.wonWork?.leadsCovered ?? 0;
    totals.quotedLookedFor += j.wonWork?.quotedLookedFor ?? 0;
    totals.quotedGained += j.wonWork?.quotedGained ?? 0;

    console.log(`pass ${pass}: checked ${j.checked ?? 0}, ${j.remaining ?? 0} left${j.tookMs ? ` (${Math.round(j.tookMs / 1000)}s)` : ''}${j.reason ? ` — ${j.reason}` : ''}`);
    for (const r of j.report ?? []) {
      if (r.companyId) seen.set(r.companyId, (seen.get(r.companyId) ?? 0) + 1);
      const bits = [
        r.leads ? `${r.leads} won-work lead${r.leads === 1 ? '' : 's'}` : null,
        r.hiringNow ? 'Hiring now' : null,
        r.postingContacts ? `${r.postingContacts} on adverts` : null,
        r.orgContacts ? `${r.orgContacts} on the organisation page` : null,
        r.attendeesOnSite?.kept ? `${r.attendeesOnSite.kept} attendee(s) on site` : null,
        r.quoted ? `quoted ${r.quoted.gained}/${r.quoted.lookedFor} gained a detail` : null,
        r.switchboard ? 'switchboard' : null,
        r.general ? 'general email' : null,
        r.stopped ? `STOPPED: ${r.stopped}` : null,
        r.error ? `ERROR: ${r.error}` : null,
      ].filter(Boolean);
      console.log(`    ${String(r.company).padEnd(28)} ${bits.join(' · ') || 'nothing found'}`);
    }

    if (j.done || (j.remaining ?? 0) === 0) break;
  }

  const twice = [...seen.entries()].filter(([, n]) => n > 1);
  console.log(`\n${totals.passes} pass${totals.passes === 1 ? '' : 'es'} · ${totals.checked} companies checked · skipped with no site on file ${totals.skippedNoSite}`);
  console.log(`posting contacts written : ${totals.postingContacts}`);
  console.log(`organisation page        : ${totals.orgContacts} contacts across ${totals.orgYielding} companies`);
  console.log(`won work                 : ${totals.wonCompanies} companies read for ${totals.wonLeads} leads · quoted people looked for ${totals.quotedLookedFor}, gained a detail ${totals.quotedGained}`);
  console.log(`companies read more than once in this run: ${twice.length}${twice.length ? ` — ${twice.map(([id, n]) => `${id} ×${n}`).join(', ')}` : ''}`);
})();
