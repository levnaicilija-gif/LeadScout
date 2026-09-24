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

  // Companies with a board that no person has ruled on and this job has not yet read.
  //
  // ITEM 20 STEP 2B LEFT THIS ONE SITE ON THE OLD COLUMN, deliberately, and 2c must resolve it.
  // The predicate here is the ABSENCE of an override — "no person has ruled on it" — and that is a
  // negative over a table that is sparse by design: 3 rows of 5,889 companies. PostgREST cannot
  // express "has no state row, OR has one whose override is null" through an embed, and the two ways
  // round it are both the ceiling the owner rejected for leads on 2026-09-24: excluding the
  // overridden ids by `.not('id','in',(…))` works at 3 and breaks at roughly 200, and filtering the
  // batch in memory can hand back a batch that is entirely overridden and do no work.
  //
  // It is CORRECT as it stands, because 2b dual-writes: api/company/employer-type writes the state
  // row and this column together, so the column is current. It is written down rather than quietly
  // left because a dual-written column stops being current the moment 2c removes the second write.
  let q = db.from('companies').select('id, name, domain, careers_url, employer_type, employer_type_override, employer_type_source')
    .eq('careers_status', 'found').is('employer_type_override', null).is('employer_type_checked_at', null)
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
    .eq('careers_status', 'found').is('employer_type_override', null).is('employer_type_checked_at', null);

  console.log(`[classify-employers] did=${(companies ?? []).length} ${JSON.stringify(counts)} unreadable=${unreadable} remaining=${remaining} spent=EUR${budget.totalToday.toFixed(3)}`);
  return NextResponse.json({
    ok: true, did: (companies ?? []).length, counts, unreadable, remaining, chained,
    spentToday: Number(budget.totalToday.toFixed(4)),
    changed: changed.slice(0, 25),
  });
}
