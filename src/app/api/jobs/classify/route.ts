import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/server';
import { claude, MODEL_CLASSIFY } from '@/lib/ai/claude';
import { logModelCall, Budget } from '@/lib/cost';
export const maxDuration = 300;

/**
 * Classify the companies the name-keyword pass could not place, before spending anything on
 * resolving their domains. The attendee's job title is the strongest signal available: "Head
 * of Site Operations" says the employer runs assets, "Partner" says law firm, "Fund Manager"
 * says investor. So each company goes to the model as its name plus the titles of the people
 * recorded against it.
 *
 *   POST /api/jobs/classify?limit=2000&batch=30
 *
 * Cheap by construction: Haiku, titles only (never the people's names), batched, and the
 * instructions sit in a cached system prompt.
 */
const authorised = (req: Request) => {
  const s = process.env.CRON_SECRET;
  return !!s && (req.headers.get('x-cron-secret') === s || req.headers.get('authorization') === `Bearer ${s}`);
};

export const GET = (req: Request) => run(req);
export const POST = (req: Request) => run(req);

const SECTORS = ['offshore_wind', 'shipyard', 'oil_gas', 'epc', 'industrial', 'marine_contractor', 'om_service', 'irrelevant'] as const;

const SYSTEM = `You classify employers for an industrial and offshore staffing agency. The agency supplies manual trades: welders, pipefitters, platers, painters, blasters, NDT technicians, rope access technicians, wind turbine technicians, electricians and scaffolders.

For each company decide the single best sector:
- offshore_wind    developers, owners and operators of wind farms, turbine and blade makers, foundation and cable suppliers
- shipyard         shipyards, newbuild and repair yards, drydocks
- oil_gas          oil and gas operators, subsea, drilling, refineries, LNG, terminals
- epc              EPC and EPCI contractors, engineering and construction firms, installation contractors
- industrial       steel and metal fabrication, coating, insulation, scaffolding, plant maintenance, manufacturing
- marine_contractor  offshore marine contractors, vessel owners and operators, heavy lift, survey, dredging
- om_service       operations and maintenance service providers, inspection and technical service companies
- irrelevant       anyone who does not employ manual trades: banks, investors, insurers, law firms, management and strategy consultancies, software and IT, research institutes and universities, media and events, industry associations, government bodies, ports authorities acting only as landlords, recruitment agencies

Judge by what the company DOES, not by the sector it sells into: a law firm advising wind developers is irrelevant; a bank financing shipyards is irrelevant.
The job titles are your strongest evidence. Operations, production, yard, site, HSE, technical, maintenance, fabrication and project titles point to a real employer of trades. Partner, associate, analyst, investment, policy, professor, editor and account-manager titles point to irrelevant.
When the evidence genuinely does not say, answer irrelevant only if the name clearly indicates a non-industrial business; otherwise pick the closest industrial sector.`;

const Out = z.object({
  results: z.array(z.object({ i: z.number(), sector: z.enum(SECTORS) })).default([]),
});

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const db = supabaseAdmin();
  const p = new URL(req.url).searchParams;
  const limit = Number(p.get('limit') ?? 1500);
  const size = Number(p.get('batch') ?? 30);

  const { data: ws } = await db.from('workspaces').select('id').limit(1).maybeSingle();
  if (!ws) return NextResponse.json({ error: 'no workspace' }, { status: 400 });
  const workspace = ws.id as string;

  const budget = await Budget.open(db, workspace, Number(p.get('cap') ?? 5));
  if (budget.exhausted) return NextResponse.json({ ok: false, reason: 'daily budget already spent', spentToday: budget.totalToday });

  // Only the ones the keyword pass could not place, and only inside the gate.
  const { data: todo } = await db.from('companies')
    .select('id, name, country')
    .eq('workspace_id', workspace).eq('sector', 'other').neq('tier', 'outside')
    .limit(limit);
  if (!todo || todo.length === 0) return NextResponse.json({ ok: true, done: true, classified: 0, note: 'nothing left with sector=other' });

  // Titles recorded against each name, capped so one big employer cannot dominate the prompt.
  const titles = new Map<string, string[]>();
  const names = todo.map((c) => c.name);
  for (let i = 0; i < names.length; i += 100) {
    const { data: people } = await db.from('people').select('company_name, title').eq('workspace_id', workspace).in('company_name', names.slice(i, i + 100));
    for (const p2 of people ?? []) {
      const k = p2.company_name as string;
      const list = titles.get(k) ?? [];
      if (p2.title && list.length < 6 && !list.includes(p2.title)) list.push(p2.title);
      titles.set(k, list);
    }
  }

  const stats: Record<string, number> = {};
  let classified = 0, calls = 0, stoppedFor: string | null = null;

  for (let i = 0; i < todo.length; i += size) {
    if (budget.exhausted) { stoppedFor = 'budget'; break; }
    const chunk = todo.slice(i, i + size);
    const payload = chunk.map((c, idx) => ({ i: idx, name: c.name, country: c.country ?? undefined, titles: titles.get(c.name) ?? [] }));

    let parsed: z.output<typeof Out>;
    try {
      const r = await claude.messages.create({
        model: MODEL_CLASSIFY,
        max_tokens: 1200,
        // No cache_control: this system prompt is ~600 tokens, well under Haiku's minimum
        // cacheable prefix, so a breakpoint here would never produce a cache hit.
        system: SYSTEM + '\nReturn JSON only: {"results":[{"i":0,"sector":"..."}]}',
        messages: [{ role: 'user', content: JSON.stringify(payload) }],
      });
      calls++;
      budget.add(await logModelCall(db, workspace, MODEL_CLASSIFY, `classify ${chunk.length} companies`, r.usage));
      const text = r.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');
      const m = text.match(/\{[\s\S]*\}/);
      parsed = Out.parse(JSON.parse(m ? m[0] : text));
    } catch {
      continue; // a bad batch must not stop the rest
    }

    for (const res of parsed.results) {
      const c = chunk[res.i];
      if (!c) continue;
      await db.from('companies').update({ sector: res.sector }).eq('id', c.id);
      stats[res.sector] = (stats[res.sector] ?? 0) + 1;
      classified++;
    }
  }

  const { count: remaining } = await db.from('companies').select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspace).eq('sector', 'other').neq('tier', 'outside');

  return NextResponse.json({
    ok: true, classified, calls, byResult: stats, remaining, stoppedFor,
    spentTodayEur: Number(budget.totalToday.toFixed(4)),
  });
}
