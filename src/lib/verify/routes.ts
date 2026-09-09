import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * How a certificate can be confirmed (route) and how far that confirmation got (state).
 *
 * These are separate on purpose. The route is a property of the issuing body — some publish a
 * register, some only honour a credential link, some answer email, some show nothing to
 * anybody but the holder. The state is the outcome of one attempt. Keeping them apart is what
 * lets a card say "FROSIO Inspector Level III · valid to 12/2028 · confirmation pending"
 * instead of the old "not_supported — manual check", which told a recruiter nothing.
 */
export type CertRoute = 'register' | 'credential_link' | 'issuer_email' | 'candidate_share' | 'unsupported';

export type CertState =
  | 'verified_register'
  | 'verified_credential'
  | 'confirmed_by_issuer'
  | 'consistent_with_test_report'
  | 'pending_issuer'
  | 'awaiting_candidate_share'
  | 'unsupported';

export type CertBody = {
  body: string; name: string; route: CertRoute;
  url: string | null; email: string | null; instructions: string; adapter: string | null;
};

/** Plain English for a recruiter, and for the client PDF. */
export const STATE_LABEL: Record<CertState, string> = {
  verified_register: 'verified on register',
  verified_credential: 'verified via credential link',
  confirmed_by_issuer: 'confirmed by issuer',
  consistent_with_test_report: 'consistent with test report',
  pending_issuer: 'pending issuer — email drafted',
  awaiting_candidate_share: 'awaiting candidate share',
  unsupported: 'no route to confirm yet',
};

/** Green / amber / red, matching the design's status colours. */
export const STATE_TONE: Record<CertState, 'ok' | 'warn' | 'bad'> = {
  verified_register: 'ok',
  verified_credential: 'ok',
  confirmed_by_issuer: 'ok',
  consistent_with_test_report: 'warn',
  pending_issuer: 'warn',
  awaiting_candidate_share: 'warn',
  unsupported: 'bad',
};

/** A state a client pack may carry. Anything else needs an acknowledged warning. */
export const SENDABLE: CertState[] = ['verified_register', 'verified_credential', 'confirmed_by_issuer', 'consistent_with_test_report'];

export async function loadCertBody(db: SupabaseClient, workspaceId: string, body?: string | null): Promise<CertBody | null> {
  if (!body) return null;
  // A workspace's own row wins over the built-in one.
  const { data } = await db.from('cert_bodies')
    .select('body, name, route, url, email, instructions, adapter')
    .eq('body', body).or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
    .order('workspace_id', { ascending: false, nullsFirst: false })
    .limit(1).maybeSingle();
  return (data as CertBody) ?? null;
}

/** The state an adapter result lands in, given the body's route. */
export function stateFor(route: CertRoute, adapterResult: string | null): CertState {
  if (adapterResult === 'valid' || adapterResult === 'invalid') {
    return route === 'credential_link' ? 'verified_credential' : 'verified_register';
  }
  if (adapterResult === 'consistent_with_test_report') return 'consistent_with_test_report';
  switch (route) {
    case 'issuer_email': return 'pending_issuer';
    case 'candidate_share': return 'awaiting_candidate_share';
    case 'credential_link': return 'pending_issuer';   // no link on the certificate → ask the issuer
    case 'register': return 'unsupported';             // the register answered nothing usable
    default: return 'unsupported';
  }
}

/** The verification email, addressed to the body's own office. */
export function issuerEmail(bodyName: string, to: string | null, e: any, agency: string) {
  return {
    to,
    subject: `Verification request — ${bodyName} certificate ${e?.number ?? ''}`.trim(),
    body: `Dear certification office,

Please confirm the validity of the following certificate issued by ${bodyName}:

Certificate number: ${e?.number ?? '—'}
Holder: ${e?.holder ?? '—'}
${e?.level ? `Level: ${e.level}\n` : ''}${e?.process ? `Process / position: ${e.process} ${e?.position ?? ''}\n` : ''}Issued: ${e?.issued ?? '—'}
Expiry: ${e?.expiry ?? '—'}

A copy of the certificate is attached. We are verifying it as part of a placement and would be grateful for written confirmation.

Kind regards,
${agency}`,
  };
}
