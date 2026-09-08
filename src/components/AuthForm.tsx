'use client';
import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/client';
export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const [f, setF] = useState({ email: '', password: '', name: '', agency: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [sent, setSent] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    const sb = supabaseBrowser();
    // Hard redirect, not router.push: a full load guarantees the freshly written auth cookie
    // is on the request the middleware and the server layout read.
    if (mode === 'login') { const { error } = await sb.auth.signInWithPassword({ email: f.email, password: f.password }); if (error) { setErr(error.message); setBusy(false); return; } window.location.href = '/app/today'; return; }
    else { const { error } = await sb.auth.signUp({ email: f.email, password: f.password, options: { data: { name: f.name, agency: f.agency } } }); if (error) setErr(error.message); else setSent(true); }
    setBusy(false);
  };
  const magic = async () => { setBusy(true); const sb = supabaseBrowser(); const { error } = await sb.auth.signInWithOtp({ email: f.email, options: { emailRedirectTo: `${location.origin}/app/today` } }); setErr(error?.message ?? ''); if (!error) setSent(true); setBusy(false); };
  if (sent) return <div className="text-[13px]">Check your email — we sent you a link.</div>;
  return (<form onSubmit={submit} className="text-[13px]">
    {mode === 'signup' && <><label className="block text-[12px] text-ink3 mt-3 mb-1">Your name</label><input required className="w-full border border-line rounded px-3 py-2.5" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><label className="block text-[12px] text-ink3 mt-3 mb-1">Agency name</label><input required className="w-full border border-line rounded px-3 py-2.5" value={f.agency} onChange={(e) => setF({ ...f, agency: e.target.value })} /></>}
    <label className="block text-[12px] text-ink3 mt-3 mb-1">Work email</label><input type="email" required className="w-full border border-line rounded px-3 py-2.5" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
    <label className="block text-[12px] text-ink3 mt-3 mb-1">Password</label><input type="password" required minLength={10} className="w-full border border-line rounded px-3 py-2.5" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
    {mode === 'signup' && <label className="flex gap-2 items-start mt-3 text-ink2"><input type="checkbox" required className="mt-0.5" />I agree to the Terms and confirm we use LeadScout for B2B recruitment outreach with opt-out honoured.</label>}
    {err && <div className="text-bad mt-2">{err}</div>}
    <button disabled={busy} className="btn btn-primary w-full mt-4">{busy ? '…' : mode === 'login' ? 'Sign in' : 'Create workspace'}</button>
    {mode === 'login' && <button type="button" onClick={magic} className="btn w-full mt-2">Email me a sign-in link</button>}
    <div className="text-center text-ink2 mt-4">{mode === 'login' ? <>New here? <a className="text-accent" href="/signup">Create a workspace</a></> : <>Already have a workspace? <a className="text-accent" href="/login">Sign in</a></>}</div>
  </form>);
}
