import { supabaseServer } from '@/lib/supabase/server';
import { Help } from '@/components/Help';
import { PitchClient } from '@/components/PitchClient';
export const dynamic = 'force-dynamic';
export default async function Pitch() {
  const sb = supabaseServer();
  const [{ data: cands }, { data: leads }] = await Promise.all([sb.from('candidates').select('id, reference_code, trade, profile, availability_from').limit(200), sb.from('leads').select('id, project_name, trades_inferred, project_location, confirmed_at, companies(name, employer_type), contacts(name, title, email_status)').not('status', 'in', '("stale","not_for_us")').limit(200)]);
  return (<>
    <div className="flex items-baseline justify-between mb-3"><h1 className="text-[22px] font-semibold">Pitch a candidate<Help title="What Pitch is" intro="Start from a scarce person, find who should hear about them." rows={[['Matching', 'Every open lead scored on trade, geography, timing, prior site history.'], ['Output', 'Top matches with who to send to, and a blind teaser per company — reference code only.'], ['Never', 'Reveals the candidate\'s identity in a teaser.']]} /></h1></div>
    <PitchClient candidates={cands ?? []} leads={leads ?? []} />
  </>);
}
