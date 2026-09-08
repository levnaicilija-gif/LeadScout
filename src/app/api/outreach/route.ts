import { NextResponse } from 'next/server';
import { Resend } from 'resend';
import { supabaseServer, currentUser } from '@/lib/supabase/server';
/** POST { outreach_id, to, subject, body } — the ONLY place an email leaves the system. Recruiter presses send. */
export async function POST(req: Request) {
  const me = await currentUser(); if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  const sb = supabaseServer(); const b = await req.json();
  const { data: o } = await sb.from('outreach').select('*, contacts(email, email_status), leads(companies(general_email))').eq('id', b.outreach_id).single();
  if (!o) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const allowed = [o.contacts?.email, o.leads?.companies?.general_email].filter(Boolean);
  if (!allowed.includes(b.to)) return NextResponse.json({ error: 'Recipient must be an address attached to this contact or company' }, { status: 400 });
  await new Resend(process.env.RESEND_API_KEY).emails.send({ from: process.env.RESEND_FROM!, to: b.to, subject: b.subject, text: b.body });
  await sb.from('outreach').update({ subject: b.subject, body: b.body, sent_by: me.id, sent_at: new Date().toISOString(), status: 'sent' }).eq('id', o.id);
  await sb.from('leads').update({ status: 'contacted', updated_at: new Date().toISOString() }).eq('id', o.lead_id);
  return NextResponse.json({ ok: true });
}
