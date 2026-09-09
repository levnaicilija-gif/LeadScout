import { NextResponse } from 'next/server';
import { supabaseAdmin, currentUser } from '@/lib/supabase/server';
export const maxDuration = 60;

/**
 * Send the verification email to a certifying body, and record that it went.
 *
 * Resend when it is configured; otherwise the UI falls back to a mailto so the recruiter can
 * send it from their own mailbox. Either way `issuer_email_sent_at` is stamped, because Today
 * counts the days from it.
 *
 * The only address this will send to is the one recorded against the certificate body — never
 * a free-text address typed into the browser.
 */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  try {
    const { verification_id: verificationId, mark_only: markOnly } = await req.json();
    if (!verificationId) return NextResponse.json({ error: 'verification_id required' }, { status: 400 });

    const db = supabaseAdmin();
    const { data: v } = await db.from('verifications')
      .select('id, document_id, state, documents!inner(workspace_id, extracted, cert_body)')
      .eq('id', verificationId).maybeSingle();
    const doc: any = v?.documents;
    if (!v || doc?.workspace_id !== me.workspace_id) return NextResponse.json({ error: 'verification not found in this workspace' }, { status: 404 });

    const ext = doc.extracted ?? {};
    const { data: cb } = await db.from('cert_bodies').select('name, email')
      .eq('body', ext.cert_body ?? '').or(`workspace_id.is.null,workspace_id.eq.${me.workspace_id}`)
      .order('workspace_id', { ascending: false, nullsFirst: false }).limit(1).maybeSingle();

    const stamp = async (how: string) => {
      await db.from('verifications').update({ issuer_email_sent_at: new Date().toISOString(), notes: `${how} · awaiting reply` }).eq('id', v.id);
    };

    // The recruiter sent it from their own mailbox; we only record that.
    if (markOnly) { await stamp('Issuer email sent by the recruiter'); return NextResponse.json({ ok: true, sent: 'manual' }); }

    if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) {
      return NextResponse.json({ error: 'Resend is not configured, so this has to go from your own mailbox. Use "Open in email" and then mark it sent.', canMailto: true }, { status: 501 });
    }
    if (!cb?.email) return NextResponse.json({ error: `No issuer address is recorded for ${cb?.name ?? 'this body'}. Add one in cert_bodies.` }, { status: 400 });

    const { subject, body } = await req.json().catch(() => ({ subject: '', body: '' })) as any;
    const { Resend } = await import('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const sent = await resend.emails.send({
      from: process.env.RESEND_FROM!, to: cb.email,
      subject: subject || `Verification request — ${cb.name} certificate ${ext.number ?? ''}`.trim(),
      text: body || 'Please confirm the validity of the attached certificate.',
    });
    if ((sent as any).error) return NextResponse.json({ error: String((sent as any).error?.message ?? 'Resend refused the message') }, { status: 502 });

    await stamp(`Issuer email sent to ${cb.email}`);
    return NextResponse.json({ ok: true, sent: 'resend', to: cb.email });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
