/**
 * Can this installation actually send an email, and if not, why not.
 *
 * Asked once per process and remembered, the same way schema-features asks whether a column
 * exists. The point is that nothing about sending is a flag somebody has to remember to flip:
 * when the domain verifies at Resend, the next process to ask gets a different answer and the
 * button turns on by itself. A hardcoded boolean would need a deploy to tell the truth.
 *
 * The answer is never "hide the button". A recruiter who cannot see the send button assumes the
 * feature does not exist; one who sees it disabled with "domain not verified yet" knows exactly
 * what is missing and who has to fix it. Drafts generate either way — the draft is the work.
 */

export type SendCapability = {
  /** Can an email leave the system right now? */
  canSend: boolean;
  /** Plain English, shown under a disabled button. Empty when canSend. */
  reason: string;
  /** What the recruiter can still do — always at least one thing. */
  fallback: 'resend' | 'mailto';
  from?: string;
  domain?: string;
  /** Set when the check itself could not be completed, so the answer is "unknown", not "no". */
  checkFailed?: string;
};

let cached: { at: number; value: SendCapability } | null = null;
const TTL_MS = 5 * 60_000;

const domainOf = (from?: string) => (from ?? '').split('@')[1]?.replace(/>$/, '').trim();

/**
 * Resend's own answer about the sending domain.
 *
 * A key and a from-address are not enough: mail from an unverified domain is accepted by the
 * API and then silently not delivered, which is the worst of the three outcomes because the
 * recruiter believes it went.
 */
async function domainVerified(apiKey: string, domain: string): Promise<{ ok: boolean; why?: string; failed?: string }> {
  try {
    const r = await fetch('https://api.resend.com/domains', {
      headers: { authorization: `Bearer ${apiKey}` },
      cache: 'no-store',
    });
    if (r.status === 401 || r.status === 403) return { ok: false, why: 'the Resend API key is not accepted' };
    if (!r.ok) return { ok: false, failed: `Resend answered HTTP ${r.status}` };
    const j: any = await r.json();
    const rows: any[] = j?.data ?? [];
    const hit = rows.find((d) => String(d?.name ?? '').toLowerCase() === domain.toLowerCase());
    if (!hit) return { ok: false, why: `${domain} is not set up at Resend yet` };
    const status = String(hit.status ?? '').toLowerCase();
    if (status !== 'verified') return { ok: false, why: `${domain} is ${status || 'not verified'} at Resend` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, failed: String(e?.message ?? e).slice(0, 120) };
  }
}

export async function sendCapability(force = false): Promise<SendCapability> {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.value;

  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const domain = domainOf(from);

  let value: SendCapability;
  if (!key) value = { canSend: false, reason: 'no Resend API key is configured', fallback: 'mailto' };
  else if (!from) value = { canSend: false, reason: 'no from-address is configured (RESEND_FROM)', fallback: 'mailto' };
  else if (!domain) value = { canSend: false, reason: `RESEND_FROM ("${from}") is not an email address`, fallback: 'mailto' };
  else {
    const v = await domainVerified(key, domain);
    value = v.ok
      ? { canSend: true, reason: '', fallback: 'resend', from, domain }
      : {
          canSend: false,
          // A failed check is not a verdict. Say which one it is, because "we could not ask" and
          // "the answer is no" call for different actions from the person reading it.
          reason: v.failed ? `could not check the sending domain — ${v.failed}` : `domain not verified yet — ${v.why}`,
          fallback: 'mailto', from, domain, checkFailed: v.failed,
        };
  }

  cached = { at: Date.now(), value };
  return value;
}

/** For tests and for the settings screen: forget the answer and ask again. */
export const forgetSendCapability = () => { cached = null; };
