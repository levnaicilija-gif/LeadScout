import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: { headers: req.headers } });
  const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      get: (n: string) => req.cookies.get(n)?.value,
      // Write the refreshed cookie onto the request too, so the server components rendered
      // by this same request read the new token rather than the one that just expired.
      set: (n: string, v: string, o: any) => {
        req.cookies.set({ name: n, value: v, ...o });
        res = NextResponse.next({ request: { headers: req.headers } });
        res.cookies.set({ name: n, value: v, ...o });
      },
      remove: (n: string, o: any) => {
        req.cookies.set({ name: n, value: '', ...o });
        res = NextResponse.next({ request: { headers: req.headers } });
        res.cookies.set({ name: n, value: '', ...o });
      },
    },
  });

  const { data: { user } } = await sb.auth.getUser();
  if (req.nextUrl.pathname.startsWith('/app') && !user) {
    const to = NextResponse.redirect(new URL('/login', req.url));
    // Carry any cookie Supabase just refreshed onto the redirect, or it is lost.
    for (const c of res.cookies.getAll()) to.cookies.set(c);
    return to;
  }
  return res;
}

export const config = { matcher: ['/app/:path*'] };
