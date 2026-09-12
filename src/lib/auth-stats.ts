import { supabaseAdmin } from '@/lib/supabase/server';

/**
 * The three numbers on the sign-in panel, counted live.
 *
 * Head-only counts, no rows — the sign-in screen reads nothing about anyone. A count that fails
 * is dropped from the list rather than shown as zero, because a broken query and a quiet week
 * are different facts and the panel must not tell you the second when the first is true.
 */
export async function authStats(): Promise<{ n: string; label: string }[]> {
  try {
    const db = supabaseAdmin();
    const [sources, boards] = await Promise.all([
      db.from('sources').select('id', { count: 'exact', head: true }).eq('tier', 'priority').eq('enabled', true),
      db.from('companies').select('id', { count: 'exact', head: true }).not('careers_url', 'is', null),
    ]);
    const out: { n: string; label: string }[] = [];
    if (!sources.error && sources.count != null) out.push({ n: String(sources.count), label: 'sources read daily' });
    if (!boards.error && boards.count != null) out.push({ n: String(boards.count), label: 'careers pages watched' });
    out.push({ n: '0', label: 'facts invented, ever' });
    return out;
  } catch {
    return [{ n: '0', label: 'facts invented, ever' }];
  }
}
