import { NextResponse } from 'next/server';
import { Resend } from 'resend';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
import { sendCapability } from '@/lib/send-capability';
export const maxDuration = 60;

/**
 * The ONLY place an email leaves the system. A recruiter presses send; nothing here sends itself.
 *
 * Two things are checked before anything goes out, and both refuse rather than improvise:
 *
 *   the recipient — must already be an address attached to this contact or this company. A
 *                   pattern address is not an address: it was constructed, never confirmed, and
 *                   a first email to a guessed mailbox is how a domain gets a spam complaint.
 *   the sender    — sendCapability() asks Resend whether the domain is verified. Mail from an
 *                   unverified domain is accepted by the API and then quietly not delivered,
 *                   which is worse than a refusal because the recruiter believes it went.
 *
 * GET returns the capability so the button can render disabled with the reason on it.
 */
export async function GET() {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  return NextResponse.json(await sendCapability());
}

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  const sb = supabaseServer();
  const b = await req.json();

  const { data: o } = await sb.from('outreach')
    .select('*, contacts(email, email_status), leads(companies(general_email)), companies(general_email, name)')
    .eq('id', b.outreach_id).maybeSingle();
  if (!o) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // An approach written from postings has a company and no lead; one written from a lead has
  // both. Either way the recipient must be an address someone read off a page.
  const allowed = [
    (o as any).contacts?.email,
    (o as any).leads?.companies?.general_email,
    (o as any).companies?.general_email,
  ].filter(Boolean);
  if (!allowed.includes(b.to)) {
    return NextResponse.json({
      error: 'The recipient must be an address already attached to this contact or company. A pattern address was built, not confirmed, and is not something to send a first email to.',
    }, { status: 400 });
  }
  if ((o as any).contacts?.email === b.to && (o as any).contacts?.email_status === 'pattern') {
    return NextResponse.json({ error: 'That address is a pattern, not a confirmed address. Confirm it first, or send to the company address.' }, { status: 400 });
  }

  const cap = await sendCapability();
  if (!cap.canSend) {
    // Not an error the recruiter caused, and not something to retry — say what is missing.
    return NextResponse.json({ error: `Cannot send yet: ${cap.reason}. The draft is saved; copy it or use the mail client instead.`, capability: cap }, { status: 409 });
  }

  try {
    await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: process.env.RESEND_FROM!, to: b.to, subject: b.subject, text: b.body,
    });
  } catch (e: any) {
    return NextResponse.json({ error: `Resend refused it: ${String(e?.message ?? e).slice(0, 200)}` }, { status: 502 });
  }

  await sb.from('outreach').update({
    subject: b.subject, body: b.body, sent_by: me.id, sent_at: new Date().toISOString(), status: 'sent',
  }).eq('id', o.id);
  if (o.lead_id) await sb.from('leads').update({ status: 'contacted', updated_at: new Date().toISOString() }).eq('id', o.lead_id);

  return NextResponse.json({ ok: true, to: b.to });
}
