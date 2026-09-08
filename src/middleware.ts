import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
export async function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: { get: (n: string) => req.cookies.get(n)?.value, set: (n: string, v: string, o: any) => res.cookies.set({ name: n, value: v, ...o }), remove: (n: string, o: any) => res.cookies.set({ name: n, value: '', ...o }) },
  });
  const { data: { user } } = await sb.auth.getUser();
  if (req.nextUrl.pathname.startsWith('/app') && !user) return NextResponse.redirect(new URL('/login', req.url));
  return res;
}
export const config = { matcher: ['/app/:path*'] };
