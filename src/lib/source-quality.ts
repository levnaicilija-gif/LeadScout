/**
 * Queue item 14 (4): say what is wrong with a lead's source instead of silently accepting it.
 *
 *   broken       the page is gone: 404, 410, a server error, a host that does not resolve
 *   unreachable  it did not load for another reason: 403, 429, a bot wall, no browser available
 *   paywall      it loaded, but the story is behind a subscription
 *   sign_in      it loaded, but reading it needs an account
 *   landing      it loaded, but it is a section or home page, not the article asked for
 *   ok           none of the above
 *
 * Measured on stored pages 2026-09-13: "to continue reading" on 10 geodrillinginternational
 * articles (about 2,400 characters each), "for subscribers" with "Please login" on 3 rechargenews
 * articles, "Please sign in" on one windeurope.org page. offshorewind.biz's newsletter footer
 * ("Subscribe →") is not a paywall and does not match.
 */
import type { Fetched } from './fetch-page';
import { articleLinks } from './fetch-page';

export type SourceFlag = 'ok' | 'broken' | 'unreachable' | 'landing' | 'paywall' | 'sign_in';

const PAYWALL = /(subscribe (now )?to (continue|read|unlock)|to continue reading|already a subscriber|for subscribers|subscribers only|premium (article|content)|unlock (this|the full) article)/i;
const SIGN_IN = /(sign in to (continue|read|view)|log ?in to (continue|read|view)|please (sign|log) ?in|you must be (logged|signed) in|register to (read|continue))/i;
const GONE = /HTTP (404|410|5\d\d)|plain fetch failed|ENOTFOUND|getaddrinfo|browser got HTTP (404|410)/i;

const slugWords = (url: string) => {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    return (last.toLowerCase().match(/[a-z]{5,}/g) ?? []);
  } catch { return []; }
};
const depth = (url: string) => { try { return new URL(url).pathname.split('/').filter(Boolean).length; } catch { return 0; } };

export function sourceFlag(f: Pick<Fetched, 'url' | 'status' | 'text' | 'title' | 'note' | 'links' | 'via'> & { finalUrl?: string }, ctx: { requestedUrl: string; sourcePaywalled?: boolean }): { flag: SourceFlag; why: string } {
  if (f.status !== 'live') {
    return GONE.test(f.note ?? '')
      ? { flag: 'broken', why: `the page is gone — ${f.note}` }
      : { flag: 'unreachable', why: `the page did not load — ${f.note ?? 'no reason given'}` };
  }
  const text = f.text ?? '';
  const paywall = text.match(PAYWALL);
  if (paywall && text.length < 3000) return { flag: 'paywall', why: `"${paywall[0]}" on a page of ${text.length} characters` };
  if (ctx.sourcePaywalled && text.length < 1500) return { flag: 'paywall', why: `a source marked paywalled, and only ${text.length} characters came back` };
  const signIn = text.match(SIGN_IN);
  if (signIn && (text.length < 3000 || (signIn.index ?? 0) < text.length * 0.3)) return { flag: 'sign_in', why: `"${signIn[0]}" on the page` };

  // Asked for a story, landed on a home or section page.
  if (f.finalUrl && depth(ctx.requestedUrl) >= 1 && slugWords(ctx.requestedUrl).length >= 2 && depth(f.finalUrl) <= 1 && slugWords(f.finalUrl).length === 0) {
    return { flag: 'landing', why: `redirected to ${f.finalUrl}` };
  }
  const words = slugWords(ctx.requestedUrl);
  if (words.length >= 3) {
    const head = `${f.title ?? ''} ${text.slice(0, 1500)}`.toLowerCase();
    const found = words.filter((w) => head.includes(w)).length;
    if (found / words.length < 0.4 && articleLinks(f as Fetched, 50).length >= 10) {
      return { flag: 'landing', why: `only ${found} of ${words.length} words from the link appear in the page's title and opening, and it lists many other articles` };
    }
  }
  return { flag: 'ok', why: 'loaded as an article' };
}
