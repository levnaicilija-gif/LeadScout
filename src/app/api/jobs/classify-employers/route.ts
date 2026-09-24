import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/server';
import { crawlWorkspace } from '@/lib/crawl-workspace';
import { httpGet } from '@/lib/http';
import { fetchPage } from '@/lib/fetch-page';
import { claude, MODEL_CLASSIFY } from '@/lib/ai/claude';
import { logModelCall, Budget, DAILY_BUDGET_EUR } from '@/lib/cost';
import { verdictPatch } from '@/lib/employer-verdict';
import { hasEmployerEvidence } from '@/lib/schema-features';
export const maxDuration = 300;

/**
 * Read each company's own careers page and say what kind of company it is.
 *
 * The name-based detector is silent on most of them — "Karstensens" says nothing — so 311
 * companies with a board sat at "unknown" and the agency toggle on Hiring now could only hide
 * what a name or an override happened to reveal. A careers page answers it plainly: a shipyard
 * advertising its own welders reads nothing like an agency advertising other people's.
 *
 * Two rules:
 *   an override is never touched — a person's decision is not this job's to revisit;
 *   "unknown" is only written where the page genuinely says nothing, never over a known value.
 *
 *   POST /api/jobs/classify-employers?batch=25&cap=1
 */
const authorised = (req: Request) => {
  const s = process.env.CRON_SECRET;
  return !!s && (req.headers.get('x-cron-secret') === s || req.headers.get('authorization') === `Bearer ${s}`);
};

export const GET = (req: Request) => run(req);
export const POST = (req: Request) => run(req);

const Verdict = z.object({
  employer_type: z.enum(['end_client', 'epc_contractor', 'staffing_agency', 'unknown']),
  // Trimmed, not refused. A reply whose sentence ran past 300 characters was a sound classification thrown away
  // whole: 57 companies stored "could not be read: too_big" as their evidence, 51 stayed unknown, and 6 kept a guess
  // from their name (EnBW Offshore Wind Norway, a wind-farm owner, as an EPC contractor).
  evidence: z.string().transform((s) => (s.length > 300 ? `${s.slice(0, 297).trimEnd()}…` : s)),
});

const SYSTEM = `You are reading a company's own careers page for RFBT, a staffing company that supplies skilled trades.

RFBT needs to know which of three things this company is:

- "staffing_agency" — it supplies people to other companies. Its vacancies are for roles at unnamed clients ("our client, a leading contractor"), it advertises many identical roles across many towns, it talks about registering, a talent pool, or being placed. These are RFBT's competitors and their adverts are not customer demand.
- "epc_contractor" — it builds, fabricates, installs or maintains things for others under contract: EPC, marine and offshore contracting, industrial services, shipbuilding and repair, insulation, scaffolding, surface treatment. It employs trades directly.
- "end_client" — it owns or operates the asset and hires directly for it: an energy company, a utility, a port, a manufacturer, a wind farm owner.

Decide from what the page actually says about the company and the roles it advertises. If the page does not make it clear, answer "unknown" — a guess here hides a customer or shows a competitor.

"evidence" is one short sentence quoting or naming what on the page decided it.

Return JSON only: {"employer_type":"...","evidence":"..."}`;

async function readCareers(c: any): Promise<string | null> {
  const url = c.careers_url || (c.domain ? `https://${c.domain}` : null);
  if (!url) return null;
  const r = await httpGet(url, {}, 15000);
  if (r.ok && r.body && r.body.length > 500) {
    const $ = cheerio.load(r.body);
    $('script, style, noscript, svg').remove();
    const roles = $('a[href], h2, h3').slice(0, 120).map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get()
      .filter((t) => t.length > 8).slice(0, 30).join(' | ');
    return [
      `TITLE: ${$('title').first().text().trim()}`,
      `DESCRIPTION: ${$('meta[name="description"]').attr('content') ?? ''}`,
      `TEXT: ${$('body').text().replace(/\s+/g, ' ').trim().slice(0, 1400)}`,
      `ROLES ADVERTISED: ${roles.slice(0, 1200)}`,
    ].join('\n');
  }
  const rendered = await fetchPage(url, { force: 'browser' });
  if (rendered.status !== 'live') return null;
  return `TITLE: ${rendered.title}\nTEXT: ${rendered.text.replace(/\s+/g, ' ').slice(0, 2200)}`;
}

async function pool<T>(items: T[], size: number, fn: (t: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(size, q.length) }, async () => {
    for (let it = q.shift(); it; it = q.shift()) await fn(it);
  }));
}

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const p = new URL(req.url).searchParams;
  const batch = Math.max(1, Number(p.get('batch') ?? 25));
  // A caller may spend less than the daily budget, never more.
  const cap = Math.min(Number(p.get('cap') ?? 1) || 0, DAILY_BUDGET_EUR);
  // A named set (comma-separated ids), read before anything else in the queue: the 57 too_big failures on 2026-09-15.
  const ids = (p.get('ids') ?? '').split(',').map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s));
  const chain = p.get('chain') !== '0';
  const batchesLeft = Number(p.get('batchesLeft') ?? 20);
  const only = p.get('only');

  if (!(await hasEmployerEvidence(db))) {
    return NextResponse.json({ ok: true, skipped: 'migration 0017 has not been applied yet' });
  }

  // Named, never "the first workspace": with two workspaces an unordered limit(1) could file this job's work under either.
  const ws = await crawlWorkspace(db).then((id) => ({ id, error: '' }), (e: Error) => ({ id: '', error: e.message }));
  if (!ws.id) return NextResponse.json({ error: ws.error }, { status: 500 });
  const budget = await Budget.open(db, cap);
  if (budget.exhausted) return NextResponse.json({ ok: true, stopped: 'daily budget already spent', spentToday: Number(budget.totalToday.toFixed(4)) });

  // Companies with a board this job has not yet read.
  //
  // THE OVERRIDE FILTER IS GONE, and its absence is the point rather than an omission. Until item 20
  // step 2b this query also said `.is('employer_type_override', null)` — skip anything a person has
  // ruled on — because the override and the detected type shared a row and re-classifying could
  // overwrite somebody's judgement. api/company/employer-type's own comment states that as the
  // reason the two were stored separately in the first place.
  //
  // They are now in SEPARATE TABLES. The override lives in workspace_company_state, this job writes
  // only companies.employer_type and its provenance (verdictPatch never touches an override), and
  // effectiveEmployerType still prefers the override over the detected value. So the thing the
  // filter protected is protected by the schema, and the filter is no longer doing the job it was
  // written for.
  //
  // Reimplementing it against the state table would also have been WRONG, not merely awkward: it
  // would let ONE workspace's private correction stop the SHARED fact being determined for every
  // other workspace, which is precisely what item 20 exists to prevent. A private judgement must not
  // silently rewrite another customer's view, and suppressing the crawl is a way of doing that.
  //
  // Measured before removing it, 2026-09-24: of 370 companies with a careers page, 28 are
  // unclassified, 25 were already in this queue and 3 were excluded by the override filter — so this
  // adds exactly 3 companies, once. 0 companies are overridden AND already classified, so nothing is
  // re-classified in a burst. `employer_type_checked_at is null` still bounds the work to once per
  // company, which was always the filter that mattered.
  let q = db.from('companies').select('id, name, domain, careers_url, employer_type, employer_type_source')
    .eq('careers_status', 'found').is('employer_type_checked_at', null)
    .order('id').limit(batch);
  if (only) q = q.ilike('name', `%${only}%`);
  if (ids.length) q = q.in('id', ids);
  const { data: companies, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Dispatched before the work, so a batch killed by the 300 s wall keeps the chain alive.
  let chained = false;
  if (chain && !only && (companies ?? []).length === batch && batchesLeft > 1) {
    const u = new URL(req.url);
    u.searchParams.set('batchesLeft', String(batchesLeft - 1));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    await fetch(u.toString(), { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET! }, signal: ac.signal }).catch(() => {});
    chained = true;
  }

  const counts: Record<string, number> = {};
  const changed: any[] = [];
  let unreadable = 0;

  await pool(companies ?? [], 6, async (c: any) => {
    if (budget.exhausted) return;
    try {
      const sample = await readCareers(c);
      if (!sample) {
        unreadable++;
        // Record the attempt so the next run does not repeat it, but change nothing.
        await db.from('companies').update({ employer_type_checked_at: new Date().toISOString(), employer_type_evidence: 'careers page could not be read' }).eq('id', c.id);
        return;
      }

      const ai = await claude.messages.create({
        model: MODEL_CLASSIFY, max_tokens: 250, system: SYSTEM,
        messages: [{ role: 'user', content: `Company: ${c.name}\nCareers page: ${c.careers_url ?? c.domain}\n\n${sample}` }],
      });
      budget.add(await logModelCall(db, ws.id, MODEL_CLASSIFY, `employer type ${c.name}`, ai.usage));
      const text = ai.content.filter((x) => x.type === 'text').map((x: any) => x.text).join('');
      const v = Verdict.parse(JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}'));
      counts[v.employer_type] = (counts[v.employer_type] ?? 0) + 1;

      // A specific answer is never traded for "unknown", and a kept answer keeps its origin (see verdictPatch).
      const { patch, changedTo } = verdictPatch(c, v);
      await db.from('companies').update(patch).eq('id', c.id);
      if (changedTo) changed.push({ company: c.name, from: c.employer_type ?? 'null', to: changedTo, evidence: v.evidence });
    } catch (e: any) {
      unreadable++;
      // The type is left as it was, and says what it is: a company whose page could not be classified keeps a
      // guess from its name, and that guess must never read as a careers-page answer.
      const nameGuess = c.employer_type && c.employer_type !== 'unknown';
      await db.from('companies').update({
        employer_type_checked_at: new Date().toISOString(),
        employer_type_evidence: `could not be read: ${String(e?.message ?? e).slice(0, 120)}`,
        ...(nameGuess && !c.employer_type_source ? { employer_type_source: 'name', employer_type_reason: 'careers page could not be classified; the type shown is a guess from the name' } : {}),
      }).eq('id', c.id);
    }
  });

  const { count: remaining } = await db.from('companies').select('id', { count: 'exact', head: true })
    // The same predicate as the queue above, or "remaining" would count a different set from the one
    // the next batch will actually take — the banner-and-table mismatch, in a log line.
    .eq('careers_status', 'found').is('employer_type_checked_at', null);

  console.log(`[classify-employers] did=${(companies ?? []).length} ${JSON.stringify(counts)} unreadable=${unreadable} remaining=${remaining} spent=EUR${budget.totalToday.toFixed(3)}`);
  return NextResponse.json({
    ok: true, did: (companies ?? []).length, counts, unreadable, remaining, chained,
    spentToday: Number(budget.totalToday.toFixed(4)),
    changed: changed.slice(0, 25),
  });
}
