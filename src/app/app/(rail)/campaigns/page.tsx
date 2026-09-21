import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { Help } from '@/components/Help';
import { CampaignsClient } from '@/components/CampaignsClient';
import { hasCampaignFields } from '@/lib/schema-features';
import { docStatuses, packReady, type DocStatus } from '@/lib/campaign-docs';
export const dynamic = 'force-dynamic';

/**
 * Campaigns — a batch of people going to one client for one scope, and what each of them is
 * still missing before they can travel.
 *
 * The table has existed since the first migration and never had a screen, so the documents a
 * campaign requires were recorded nowhere and Today could not tell a recruiter that four people
 * were short of a medical three weeks before the start.
 */
export default async function Campaigns() {
  const me = await currentUser();
  const sb = supabaseServer();

  // 0015 adds the campaign columns; until it lands the screen says so rather than failing.
  const ready = await hasCampaignFields(sb);
  if (!ready) {
    return (<>
      <h1 className="font-display text-[26px] font-bold tracking-[-.4px] mb-1">Campaigns</h1>
      <p className="text-ink3">Migration 0015 has not been applied yet. The screen appears as soon as it is.</p>
    </>);
  }

  const [{ data: campaigns }, { data: candidates }, { data: companies }] = await Promise.all([
    sb.from('campaigns')
      .select('id, name, site, country, starts_on, ends_on, required_docs, status, companies(name), campaign_candidates(candidate_id, candidates(id, reference_code, full_name, trade, availability_from))')
      .order('starts_on', { ascending: true, nullsFirst: false }),
    sb.from('candidates').select('id, reference_code, full_name, trade, availability_from').order('reference_code'),
    sb.from('companies').select('id, name').not('domain', 'is', null).order('name').limit(300),
  ]);

  // What each person on each campaign still owes, read from the documents actually on file and the
  // verifications behind them. Until 2026-09-21 this was a set of document TYPES held per candidate —
  // a file of that type exists, or it does not — which cannot tell a recruiter that the certificate on
  // record expired in March, or that it has never been near the issuer's register.
  const ids = [...new Set((campaigns ?? []).flatMap((c: any) => (c.campaign_candidates ?? []).map((cc: any) => cc.candidate_id)).filter(Boolean))];
  const { data: docs } = ids.length
    ? await sb.from('documents').select('id, candidate_id, type, cert_state, extracted').in('candidate_id', ids)
    : { data: [] as any[] };
  // Verifications for those documents only. If this read fails, every certificate reads "on record,
  // not checked yet" — honest for a screen that cannot see the register — rather than the rows vanishing.
  const docIds = (docs ?? []).map((d: any) => d.id);
  const { data: vers } = docIds.length
    ? await sb.from('verifications').select('document_id, state, result, valid_until').in('document_id', docIds)
    : { data: [] as any[] };

  const docsBy = new Map<string, any[]>();
  for (const d of docs ?? []) docsBy.set(d.candidate_id, [...(docsBy.get(d.candidate_id) ?? []), d]);

  // Keyed by campaign AND candidate: required_docs differ per campaign, so the same person can be
  // ready for one and short for another, and a per-candidate key would quietly show one of the two.
  const cells: Record<string, { statuses: DocStatus[]; ready: boolean; blockers: string[] }> = {};
  const readyBy: Record<string, number> = {};
  for (const c of (campaigns ?? []) as any[]) {
    const required: string[] = c.required_docs ?? [];
    let ready = 0;
    for (const cc of c.campaign_candidates ?? []) {
      const id = cc.candidate_id;
      if (!id) continue;
      const statuses = docStatuses(required, docsBy.get(id) ?? [], vers ?? []);
      const { ready: ok, blockers } = packReady(statuses);
      cells[`${c.id}:${id}`] = { statuses, ready: ok, blockers };
      if (ok) ready++;
    }
    readyBy[c.id] = ready;
  }

  return (<>
    <div className="flex items-baseline justify-between flex-wrap gap-x-3 gap-y-1 mb-3">
      <h1 className="font-display text-[26px] font-bold tracking-[-.4px]">Campaigns
        <Help
          title="What Campaigns are"
          intro="A batch of people going to one client for one scope, and the documents each of them must have before they can travel."
          rows={[
            ['The point', 'The gap. Today shows any campaign where somebody is short of a required document, and shouts when the start is inside three weeks.'],
            ['Received', 'A file of that type is on the candidate. Drop it into Verify and it appears here.'],
            ['Verified', 'Only a certificate can be verified: it has been checked against the issuer\'s own register. A passport or a medical has no register to check against, so "received" is as far as those go — the column says so rather than leaving a blank.'],
            ['Expired', 'The issuer\'s own valid-to date has passed. A candidate holding an expired certificate and a valid one reads by the valid one.'],
            ['Ready to send', 'Every required document verified where that is possible and received where it is not, with nothing expired. The pack itself adds one more test when it is sent: a client version that passed the PII check.'],
            ['Never', 'Marks a document held because somebody said so. Only a file on the candidate counts.'],
          ]}
        />
      </h1>
      <span className="text-ink3">{(campaigns ?? []).length} campaign{(campaigns ?? []).length === 1 ? '' : 's'}</span>
    </div>

    <CampaignsClient
      campaigns={(campaigns ?? []) as any}
      candidates={(candidates ?? []) as any}
      companies={(companies ?? []) as any}
      cells={cells}
      readyBy={readyBy}
      senior={me?.role === 'senior'}
    />
  </>);
}
