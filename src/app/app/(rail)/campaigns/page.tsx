import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { Help } from '@/components/Help';
import { CampaignsClient } from '@/components/CampaignsClient';
import { hasCampaignFields } from '@/lib/schema-features';
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

  // What each person on each campaign still owes, read from the documents actually on file.
  const ids = (campaigns ?? []).flatMap((c: any) => (c.campaign_candidates ?? []).map((cc: any) => cc.candidate_id)).filter(Boolean);
  const { data: docs } = ids.length
    ? await sb.from('documents').select('candidate_id, type').in('candidate_id', ids)
    : { data: [] as any[] };
  const held = new Map<string, string[]>();
  for (const d of docs ?? []) held.set(d.candidate_id, [...(held.get(d.candidate_id) ?? []), d.type]);

  return (<>
    <div className="flex items-baseline justify-between flex-wrap gap-x-3 gap-y-1 mb-3">
      <h1 className="font-display text-[26px] font-bold tracking-[-.4px]">Campaigns
        <Help
          title="What Campaigns are"
          intro="A batch of people going to one client for one scope, and the documents each of them must have before they can travel."
          rows={[
            ['The point', 'The gap. Today shows any campaign where somebody is short of a required document, and shouts when the start is inside three weeks.'],
            ['Held', 'A document counts when one of that type is on file for that candidate. Drop it into Verify and it appears here.'],
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
      held={Object.fromEntries(held)}
      senior={me?.role === 'senior'}
    />
  </>);
}
