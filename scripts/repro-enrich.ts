/**
 * Run the enrich step outside the request, one stage at a time, so the stage that throws says
 * so instead of arriving in the UI as "the client version could not be prepared".
 *
 *   npx tsx --env-file=.env.local scripts/repro-enrich.ts RFBT-F-0009
 */
import { createClient } from '@supabase/supabase-js';
import { anonymize, buildBullets, piiRegexHits, piiModelReview } from '../src/lib/ai/documents';
import { renderClientCv, clientCvText, clientCvAllowed, type ClientCvData } from '../src/lib/pdf/render';

const code = process.argv[2] ?? 'RFBT-F-0009';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const stage = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
  const t = Date.now();
  try {
    const out = await fn();
    console.log(`  ok   ${name} (${Date.now() - t}ms)`);
    return out;
  } catch (e: any) {
    console.log(`  FAIL ${name} (${Date.now() - t}ms)\n       ${String(e?.stack ?? e?.message ?? e).split('\n').slice(0, 6).join('\n       ')}`);
    throw e;
  }
};

(async () => {
  const { data: cand } = await db.from('candidates').select('*').eq('reference_code', code).maybeSingle();
  if (!cand) throw new Error(`no candidate ${code}`);
  console.log(`${cand.reference_code} — ${cand.full_name} — ${cand.trade}\n`);

  const profile: any = cand.profile ?? {};
  const anon = await stage('anonymize', () => anonymize(profile));
  const slug = String(cand.reference_code).toLowerCase();

  const { data: ws } = await db.from('workspaces').select('name').eq('id', cand.workspace_id).maybeSingle();
  const { data: verified } = await stage('load verifications', async () => db.from('verifications')
    .select('result, valid_until, checked_where, checked_at, documents!inner(candidate_id, cert_body, extracted)')
    .eq('documents.candidate_id', cand.id));
  console.log(`       ${(verified ?? []).length} verification(s)`);

  const { bullets, dropped } = await stage('buildBullets', () => buildBullets(anon, verified ?? [], undefined));
  bullets.forEach((b: string) => console.log(`       • ${b}`));
  if (dropped?.length) dropped.forEach((d: any) => console.log(`       dropped: ${JSON.stringify(d).slice(0, 140)}`));

  const pdfData: ClientCvData = {
    referenceCode: cand.reference_code,
    trade: profile.trade ?? 'Trade not stated',
    preparedOn: new Date().toISOString(),
    summary: [],
    gaps: [],
    bullets,
    certificates: (verified ?? []).map((v: any) => ({
      name: [v.documents?.cert_body?.toUpperCase(), v.documents?.extracted?.level && `Level ${v.documents.extracted.level}`].filter(Boolean).join(' ') || 'Certificate',
      number: v.documents?.extracted?.number ?? null,
      checkedWhere: v.checked_where ?? null, checkedAt: v.checked_at ?? null,
      validUntil: v.valid_until ?? null, result: v.result,
    })),
    experience: (anon.projects ?? []).map((p: any) => ({ years: p.years, what: [p.type, p.country].filter(Boolean).join(', '), rotation: p.rotation ?? null })),
    skills: anon.skills ?? [], languages: anon.languages ?? [],
    availability: anon.availability ?? null,
    publicUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/v/${slug}`.replace(/^https?:\/\//, ''),
    agencyLine: ws?.name ?? 'RFBT Recruitment',
  };

  const clientText = await stage('clientCvText', () => clientCvText(pdfData));
  const employers = (profile.projects ?? []).map((p: any) => p.employer ?? '').filter(Boolean);
  const allowed = [...clientCvAllowed(pdfData), ...(profile.certificates_claimed ?? [])];
  const regexHits = await stage('piiRegexHits', () => piiRegexHits(clientText, profile.full_name, employers, allowed));
  const review = await stage('piiModelReview', () => piiModelReview(clientText, allowed));
  const hits = [...regexHits, ...review.findings.map((f: any) => `${f.kind}: "${f.text}" — ${f.why}`)];
  console.log(`       PII hits: ${hits.length}`);
  hits.forEach((h) => console.log(`         ${h}`));

  const pdf = await stage('renderClientCv', () => renderClientCv(pdfData));
  console.log(`       PDF ${(pdf as Buffer).length} bytes`);
  console.log('\nall stages passed');
})().catch(() => process.exit(1));
