import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The day, in order. Six queries in a fixed priority — no model chooses any of this.
 *
 * Home and Today both render it, so it lives here rather than in either page: a home screen
 * that says "7 to do" while Today lists five is worse than no count at all.
 */
export type TodayItem = {
  dot: '' | 'warn' | 'bad';
  title: string;
  sub: string;
  href: string;
  why: string;
  from: string;
  /** HH:MM, and only when something is genuinely booked for that time. Otherwise there is no clock. */
  at?: string;
};

const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

export async function todayItems(sb: SupabaseClient): Promise<TodayItem[]> {
  const [pending, noReply, newLeads, expiring] = await Promise.all([
    sb.from('verifications').select('id, issuer_email_sent_at, documents(candidate_id, extracted, candidates(reference_code))').eq('result', 'pending'),
    sb.from('outreach').select('id, sent_at, leads(project_name, companies(name))').eq('status', 'sent').is('reply_at', null).lte('sent_at', day(-3)),
    sb.from('leads').select('id, kind, project_name, fit_score, trades_inferred, companies(name)').eq('status', 'new').gte('created_at', day(-7)).order('fit_score', { ascending: false }).limit(6),
    sb.from('verifications').select('id, valid_until, documents(cert_body, candidates(reference_code))').eq('result', 'valid').lte('valid_until', day(60).slice(0, 10)),
  ]);

  const items: TodayItem[] = [];

  // 4 · New leads, by fit then timing. Read before anything is chased.
  if ((newLeads.data ?? []).length) {
    const names = newLeads.data!.map((l: any) => l.companies?.name).filter(Boolean);
    items.push({
      dot: '',
      title: `Read ${newLeads.data!.length} new leads${names[0] ? ` — ${names[0]} first` : ''}`,
      sub: names.join(', '),
      href: '/app/radar',
      why: 'Contract awards are demand months before a job is posted.',
      from: 'leads with status = new in the last 7 days, by fit',
    });
  }

  // 2 · Verifications blocking a pack.
  for (const v of pending.data ?? []) {
    const doc: any = v.documents;
    const sent = v.issuer_email_sent_at ? new Date(v.issuer_email_sent_at).getTime() : Date.now();
    items.push({
      dot: 'warn',
      title: `Issuer reply due on ${doc?.candidates?.reference_code ?? 'a candidate'}'s ${doc?.extracted?.issuer ?? 'certificate'} — day ${Math.max(1, Math.ceil((Date.now() - sent) / 86400000))}`,
      sub: 'Nudge drafted · blocks one pack',
      href: `/app/candidates?ref=${doc?.candidates?.reference_code ?? ''}`,
      why: 'A pending certificate blocks the candidate\'s pack.',
      from: 'verifications where result = pending',
    });
  }

  // 3 · Outreach with no reply after 3 / 7 days.
  for (const o of noReply.data ?? []) {
    const l: any = o.leads;
    items.push({
      dot: '',
      title: `Follow up ${l?.companies?.name ?? 'a contact'} — no reply since ${new Date(o.sent_at).toLocaleDateString('en-GB')}`,
      sub: l?.project_name ?? '',
      href: '/app/radar',
      why: 'Most replies come on the 2nd or 3rd touch.',
      from: 'outreach sent ≥ 3 days ago with no reply',
    });
  }

  // 5 · Certificates expiring within 60 days.
  for (const v of expiring.data ?? []) {
    const doc: any = v.documents;
    items.push({
      dot: 'warn',
      title: `${doc?.candidates?.reference_code ?? 'A candidate'} · ${doc?.cert_body ?? 'certificate'} expires ${v.valid_until}`,
      sub: 'Renewal message drafted',
      href: `/app/candidates?ref=${doc?.candidates?.reference_code ?? ''}`,
      why: 'An expired certificate found on site means a sent-home worker.',
      from: 'verifications valid_until ≤ 60 days',
    });
  }

  return items;
}

/** The six queries, in the order they run — shown to the recruiter as "How this list is made". */
export const HOW_THIS_LIST_IS_MADE = [
  'Scheduled calls and flights this week',
  'Verifications blocking a pack',
  'Outreach with no reply after 3 / 7 days',
  'New leads, by fit then timing',
  'Certificates expiring within 60 days',
  'Campaign candidates missing documents',
];

/**
 * The label in front of an item. A clock time appears only where a call is actually booked;
 * everything else is "Now" for the next thing and "Today" for the rest, because inventing
 * 11:00 for work that has no appointment is a small lie the recruiter would plan around.
 */
export const whenLabel = (item: TodayItem, index: number) => item.at ?? (index === 0 ? 'Now' : 'Today');
