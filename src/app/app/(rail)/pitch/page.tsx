import { supabaseServer } from '@/lib/supabase/server';
import { Help } from '@/components/Help';
import { PitchClient } from '@/components/PitchClient';
import { CLOSED_LEAD_STATUSES, LEAD_STATE_EMBED, LEAD_STATE_TABLE, withLeadState } from '@/lib/workspace-state';
export const dynamic = 'force-dynamic';
export default async function Pitch() {
  const sb = supabaseServer();
  // Item 20 step 2b: open leads and their confirmation come from this workspace's own state rows,
  // then are flattened so PitchClient keeps reading `lead.confirmed_at` unchanged.
  const [{ data: cands }, { data: leadRows }] = await Promise.all([sb.from('candidates').select('id, reference_code, trade, profile, availability_from').limit(200), sb.from('leads').select(`id, project_name, trades_inferred, project_location, confirmed_at, companies(name, employer_type), contacts(name, title, email_status), ${LEAD_STATE_EMBED}`).not(`${LEAD_STATE_TABLE}.status`, 'in', CLOSED_LEAD_STATUSES).limit(200)]);
  const leads = (leadRows ?? []).map(withLeadState);
  return (<>
    <div className="flex items-baseline justify-between flex-wrap gap-x-3 gap-y-1 mb-3"><h1 className="font-display text-[26px] font-bold tracking-[-.4px]">Pitch a candidate<Help title="What Pitch is" intro="Start from a scarce person, find who should hear about them." rows={[['Matching', 'Every open lead scored on trade, geography, timing, prior site history.'], ['Output', 'Top matches with who to send to, and a blind teaser per company — reference code only.'], ['Never', 'Reveals the candidate\'s identity in a teaser.']]} /></h1></div>
    <PitchClient candidates={cands ?? []} leads={leads ?? []} />
  </>);
}
