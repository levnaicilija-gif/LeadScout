import { chromium, type Browser } from 'playwright';

/**
 * A browser, if one is available at all. Most of the app should not need this — plain HTTP
 * (src/lib/http.ts) handles server-rendered pages and JSON APIs. Reach for a browser only
 * where a page genuinely requires one: a JS-rendered app, or a reCAPTCHA-gated endpoint.
 *
 * Three ways to get one, in order:
 *   BROWSERLESS_TOKEN     browserless.io  (BROWSERLESS_URL overrides the region host)
 *   BROWSERBASE_API_KEY   browserbase.com
 *   otherwise             a local Playwright install (developer machines; never a Vercel function)
 */
export const remoteBrowserConfigured = () => !!(process.env.BROWSERLESS_TOKEN || process.env.BROWSERBASE_API_KEY);

export function browserProvider(): string {
  if (process.env.BROWSERLESS_TOKEN) return 'browserless.io';
  if (process.env.BROWSERBASE_API_KEY) return 'browserbase.com';
  // Not "local playwright": a Vercel function has none, and claiming otherwise reads as if a
  // browser were available when nothing browser-backed can run.
  return 'none configured (local Playwright only, where one is installed)';
}

export class NoBrowserError extends Error {
  constructor(cause: string) {
    super(
      `No browser available (${cause}). Set BROWSERLESS_TOKEN or BROWSERBASE_API_KEY for environments without a local Playwright install — a Vercel function is one.`,
    );
    this.name = 'NoBrowserError';
  }
}

export async function connectBrowser(): Promise<Browser> {
  const bl = process.env.BROWSERLESS_TOKEN;
  if (bl) {
    // Region host varies per account (production-sfo / production-lon / production-ams).
    const host = process.env.BROWSERLESS_URL ?? 'wss://production-sfo.browserless.io';
    return chromium.connectOverCDP(`${host}?token=${bl}`);
  }
  const bb = process.env.BROWSERBASE_API_KEY;
  if (bb) return chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${bb}`);

  // No hosted browser configured: a local install is the only remaining option.
  try {
    return await chromium.launch();
  } catch (e: any) {
    throw new NoBrowserError(String(e?.message ?? e).split('\n')[0]);
  }
}
