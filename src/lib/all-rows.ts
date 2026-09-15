/**
 * Every row a query matches, read 1,000 at a time.
 *
 * PostgREST hands back at most 1,000 rows to one read and says nothing about the rest — `.limit(10000)` does not lift
 * it. Found 2026-09-15 on item 24's scale test: Verify's intake compared a dropped CV only with a workspace's first
 * 1,000 candidates, and a test cleanup saw only 1,000 of 2,500. The query must be ordered (by id) so pages do not
 * overlap or skip.
 */
export async function allRows<T = any>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<{ data: T[]; error: { message: string } | null }> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) return { data: out, error };
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return { data: out, error: null };
  }
}
