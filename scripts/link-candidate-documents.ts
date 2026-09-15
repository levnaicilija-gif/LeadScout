/**
 * Item 24 step 8: documents that belong to nobody — a CV held back for a name decision, a certificate whose holder matched
 * no candidate — found and, where it is unambiguous, linked to the candidate they belong to.
 *
 *   npx tsx --env-file=.env.local scripts/link-candidate-documents.ts            # report only
 *   npx tsx --env-file=.env.local scripts/link-candidate-documents.ts --write    # link the unambiguous ones
 *
 * Real workspaces only (never is_test). The same rules the app uses, nothing looser:
 *   - a CV links when the duplicate rule (candidate-dedupe) finds exactly one "likely" match — a name plus an email,
 *     phone or date of birth that agrees; the CV's reading then refreshes that candidate, as attaching a CV does;
 *   - a CV with no stored reading is never linked: without an email, phone or date of birth to compare, its name alone is
 *     exactly what the duplicate rule refuses (the first report offered to link one to #4 on the name alone);
 *   - a certificate or other document links when its holder name is an exact match (name-match) for exactly one
 *     candidate — what Verify's intake does on a drop;
 *   - everything else is left loose and listed for manual review with the reason: no holder name, no match, a near or
 *     name-only match, or more than one candidate. Those stay offered on Verify's cards (AttachChoice).
 * Each link records attached_by (none: a script), attached_at and the reason when the attach trail exists (0019).
 */
import { createClient } from '@supabase/supabase-js';
import { matchName, normName } from '../src/lib/name-match';
import { judgeDuplicate } from '../src/lib/candidate-dedupe';
import { candidateLabel } from '../src/lib/candidate-number';

const WRITE = process.argv.includes('--write');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

(async () => {
  const { data: workspaces, error: wErr } = await db.from('workspaces').select('id, name, is_test').eq('is_test', false);
  if (wErr) { console.error(wErr.message); process.exit(1); }
  const { data: trail } = await db.from('documents').select('attached_by').limit(1);
  const hasTrail = trail !== null;
  let linked = 0, review = 0, total = 0;
  for (const ws of workspaces ?? []) {
    const { data: loose, error: dErr } = await db.from('documents').select('id, type, cert_body, extracted, uploaded_at, is_test').eq('workspace_id', ws.id).is('candidate_id', null).eq('is_test', false);
    if (dErr) { console.error(dErr.message); process.exit(1); }
    if (!(loose ?? []).length) continue;
    const { data: pool } = await db.from('candidates').select('id, reference_code, full_name, email, phone, profile').eq('workspace_id', ws.id).eq('is_test', false);
    const people = (pool ?? []).map((c: any) => ({ ...c, dob: c.profile?.pii?.dob ?? null }));
    console.log(`\nworkspace "${ws.name}": ${loose!.length} document(s) attached to nobody · ${people.length} candidate(s)`);
    for (const d of loose ?? []) {
      total++;
      const ext: any = d.extracted ?? {};
      const label = `${d.type}${d.cert_body ? ` (${d.cert_body})` : ''} uploaded ${String(d.uploaded_at).slice(0, 10)}`;
      let target: any = null;
      let why = '';
      if (d.type === 'cv' && !ext.profile) {
        why = `CV with no stored reading${ext.holder ? ` (it names ${ext.holder})` : ''} — nothing but a name to compare, so a recruiter decides`;
      } else if (d.type === 'cv' && ext.profile) {
        const p = ext.profile;
        const j = judgeDuplicate(people, { full_name: p.full_name, email: p.pii?.email, phone: p.pii?.phone, dob: p.pii?.dob });
        const likely = j.verdict === 'ask' ? j.matches.filter((m) => m.strength === 'likely') : [];
        if (likely.length === 1) { target = likely[0].candidate; why = `CV: ${likely[0].why}`; }
        else why = j.verdict === 'create' ? `CV for ${p.full_name ?? 'an unnamed person'}: ${j.why} — nobody to link it to` : `CV for ${p.full_name}: ${likely.length > 1 ? `${likely.length} likely matches` : 'the match is on the name only'} — a recruiter decides`;
      } else {
        const holder = ext.holder ?? null;
        if (!holder) why = 'no holder name could be read from it';
        else {
          const exact = matchName(people, holder).filter((m) => m.kind === 'exact');
          if (exact.length === 1) { target = exact[0].candidate; why = `holder "${holder}" is exactly ${exact[0].candidate.full_name}`; }
          else if (exact.length > 1) why = `holder "${holder}" matches ${exact.length} candidates exactly`;
          else { const near = matchName(people, holder); why = near.length ? `holder "${holder}" only nearly matches ${near.map((m) => candidateLabel(m.candidate.reference_code)).join(', ')}` : `nobody in the pool is called "${holder}"`; }
        }
      }
      if (target) {
        linked++;
        console.log(`  LINK    ${label} → ${candidateLabel(target.reference_code)} ${target.full_name} · ${why}`);
        if (WRITE) {
          const patch: any = { candidate_id: target.id };
          if (hasTrail) { patch.attached_at = new Date().toISOString(); patch.attach_reason = `linked by scripts/link-candidate-documents.ts (item 24) — ${why}`.slice(0, 400); }
          const { error } = await db.from('documents').update(patch).eq('id', d.id).is('candidate_id', null);
          if (error) { console.log(`          not linked: ${error.message}`); linked--; review++; continue; }
          if (d.type === 'cv' && ext.profile) await db.from('candidates').update({ profile: ext.profile, ...(ext.profile.trade ? { trade: ext.profile.trade } : {}) }).eq('id', target.id);
        }
      } else {
        review++;
        console.log(`  REVIEW  ${label} · ${why}`);
      }
    }
  }
  console.log(`\n${total} document(s) attached to nobody · ${linked} ${WRITE ? 'linked' : 'would be linked'} · ${review} left for manual review${WRITE ? '' : ' (report only — run with --write to link)'}`);
})();
