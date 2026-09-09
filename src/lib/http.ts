/**
 * Plain HTTP fetching — no browser. This is the cheap path: it costs nothing, runs anywhere
 * (a Vercel function included), and is enough for any server-rendered page or JSON API.
 * Reach for a browser only where a page genuinely needs one.
 */
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

export type HttpResult = { ok: boolean; status: number; url: string; body: string; contentType: string; error?: string };

export async function httpGet(url: string, init: RequestInit = {}, timeoutMs = 20000): Promise<HttpResult> {
  return request(url, { ...init, method: init.method ?? 'GET' }, timeoutMs);
}

export async function httpPost(url: string, body: string | URLSearchParams, headers: Record<string, string>, timeoutMs = 20000): Promise<HttpResult> {
  return request(url, { method: 'POST', body: body as any, headers }, timeoutMs);
}

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<HttpResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'user-agent': UA,
        'accept-language': 'en-GB,en;q=0.9',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, url: res.url || url, body, contentType: res.headers.get('content-type') ?? '' };
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(e?.message ?? e);
    return { ok: false, status: 0, url, body: '', contentType: '', error: msg };
  } finally {
    clearTimeout(timer);
  }
}
