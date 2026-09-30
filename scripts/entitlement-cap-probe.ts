/**
 * 0058: a capped account that has NOT chosen yet reads no classified row, and a new sign-up is capped
 * from the moment it exists.
 *
 *   npx tsx --env-file=.env.local scripts/entitlement-cap-probe.ts
 *
 * WHY IT EXISTS. A probe account created exactly as a self-signup, signed in with the ANON key, read
 * 246 of 246 leads, 5,903 of 5,903 companies and 88 of 88 contacts on 2026-09-28 — the whole discovery
 * pool, for anyone with an email address. Two facts allowed it: handle_new_user set no industry_limit,
 * and can_see_industries returns true outright when the limit is null.
 *
 * BOTH ARMS, because one alone proves nothing. A capped-and-unchosen account reading 0 leads is only
 * meaningful beside an UNCAPPED account reading them all: without the second arm, a database that had
 * simply stopped serving leads to anybody would pass.
 *
 * EXIT 2 = NOT JUDGED, the idiom priority-window and industry-follow already use: migrations here are
 * applied by hand, so until 0058 is applied this must not pass on the strength of the old function. It
 * tells them apart by asking what a FRESH sign-up was given: industry_limit 1 means 0058 is live.
 *
 * It signs in as its own throwaway account and never touches a real one. Everything it makes is removed.
 */
import { createClient } from '@supabase/supabase-js';
import { probeAdmin, markWorkspaceTest, removeProbe } from '../src/lib/test-data';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = probeAdmin();

let failed = 0;
const check = (ok: boolean, what: string, got?: unknown) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` — ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

/** One throwaway sign-up, made the way a real one is made: metadata only, and the trigger does the rest. */
async function signup(tag: string) {
  const email = `entitlement-cap-${tag}-${Date.now()}@rfbt-recruitment.com`;
  const password = `${globalThis.crypto.randomUUID()}-Aa1`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: `Entitlement Cap Probe ${tag}`, agency: `Entitlement Cap Probe ${tag}` } });
  if (created.error || !created.data.user) throw new Error(`could not create the ${tag} account: ${created.error?.message}`);
  const uid = created.data.user.id;
  const row = await admin.from('users').select('workspace_id, role, industry_limit, industry_follow').eq('id', uid).maybeSingle();
  if (row.error) throw new Error(`could not read the ${tag} account's own row: ${row.error.message}`);
  const ws = (row.data?.workspace_id as string) ?? null;
  if (ws) await markWorkspaceTest(admin, ws);
  const user = createClient(url, anonKey, { auth: { persistSession: false } });
  const signIn = await user.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(`the ${tag} account could not sign in: ${signIn.error.message}`);
  return { uid, ws, user, given: row.data };
}

const leadsVisibleTo = async (user: any) => {
  const { count, error } = await user.from('leads').select('*', { count: 'exact', head: true });
  if (error) throw new Error(`the leads could not be counted as the probe: ${error.code ?? ''} ${error.message}`);
  return count ?? 0;
};

(async () => {
  let capped: Awaited<ReturnType<typeof signup>> | null = null;
  let open: Awaited<ReturnType<typeof signup>> | null = null;
  try {
    // The service role's own total, so the two arms are measured against something real rather than a
    // number typed into this file. A literal would stop testing what it claims the moment a lead arrives.
    const total = await admin.from('leads').select('*', { count: 'exact', head: true }).not('workspace_id', 'is', null);
    if (total.error) throw new Error(`the service role could not count the leads: ${total.error.message}`);
    const everyLead = total.count ?? 0;
    const classified = await admin.from('leads').select('*', { count: 'exact', head: true })
      .not('workspace_id', 'is', null).or('industries.is.null,industries.eq.{}');
    if (classified.error) throw new Error(`the unclassified leads could not be counted: ${classified.error.message}`);
    const unclassified = classified.count ?? 0;
    console.log(`the pool holds ${everyLead} leads, ${unclassified} of them unclassified\n`);

    capped = await signup('capped');

    // ---- IS 0058 EVEN APPLIED? ------------------------------------------------------------------
    if (capped.given?.industry_limit !== 1) {
      // Measure the exposure anyway. A probe that goes quiet when the fix is absent tells you nothing
      // about why the fix exists — and this number IS the reason: it is what a stranger reads today.
      const exposed = await leadsVisibleTo(capped.user);
      console.log(`TODAY, WITHOUT 0058: this fresh sign-up reads ${exposed} of ${everyLead} leads (${everyLead ? Math.round(exposed / everyLead * 100) : 0}%).`);
      console.log(`NOT JUDGED: a fresh sign-up was given industry_limit ${JSON.stringify(capped.given?.industry_limit)}, not 1.`);
      console.log('0058 has not been applied yet, so this probe cannot say anything about the narrowed function.');
      console.log('Apply supabase/migrations/0058_capped_unchosen_sees_nothing_classified.sql and run it again.');
      process.exitCode = 2;
      return;
    }
    check(capped.given?.industry_follow == null, 'a fresh sign-up is capped but has chosen NOTHING — industry_follow stays null', capped.given);
    check(capped.given?.role === 'senior', 'and it is still a senior in its own workspace, as before 0058', capped.given?.role);

    // ---- ARM 1: capped and unchosen reads no CLASSIFIED lead ------------------------------------
    const seen = await leadsVisibleTo(capped.user);
    check(seen === unclassified, `capped and unchosen reads only the ${unclassified} unclassified lead(s), not the pool`, { seen, unclassified, everyLead });
    check(seen < everyLead, 'so it does NOT read the whole pool the way it did before 0058', { seen, everyLead });

    // ---- ARM 2: an UNCAPPED account still reads everything --------------------------------------
    // Without this, a database that had simply stopped serving leads to anyone would pass arm 1.
    open = await signup('uncapped');
    const lifted = await admin.from('users').update({ industry_limit: null }).eq('id', open.uid);
    if (lifted.error) throw new Error(`the control account could not be uncapped: ${lifted.error.message}`);
    const seenOpen = await leadsVisibleTo(open.user);
    check(seenOpen === everyLead, `an UNCAPPED account still reads all ${everyLead} leads`, { seenOpen, everyLead });
    check(seenOpen > seen, 'and the two arms genuinely differ — arm 1 is not passing because leads are hidden from everybody', { seen, seenOpen });

    // ---- ARM 3: choosing an industry opens exactly that industry --------------------------------
    // The cap must bite on what is NOT followed, not on everything for ever.
    const one = await admin.from('users').update({ industry_follow: ['offshore_wind'] }).eq('id', capped.uid);
    if (one.error) throw new Error(`the capped account could not choose an industry: ${one.error.message}`);
    const afterChoice = await leadsVisibleTo(capped.user);
    const wind = await admin.from('leads').select('*', { count: 'exact', head: true })
      .not('workspace_id', 'is', null).overlaps('industries', ['offshore_wind']);
    if (wind.error) throw new Error(`the offshore-wind leads could not be counted: ${wind.error.message}`);
    check(afterChoice === (wind.count ?? 0) + unclassified,
      `after choosing offshore_wind it reads those ${wind.count} plus the ${unclassified} unclassified, and nothing else`,
      { afterChoice, wind: wind.count, unclassified });
    check(afterChoice > seen, 'choosing an industry ADDS rows rather than leaving the account blind', { seen, afterChoice });
  } finally {
    for (const p of [capped, open]) {
      if (!p) continue;
      const left = await removeProbe(admin, p.uid, p.ws, null, { clearContent: true });
      if (left) console.log(`  cleanup problem: ${left}`);
    }
    console.log('\nthe probe accounts and their workspaces are gone');
  }

  console.log(failed ? `\n${failed} failed` : '\nentitlement cap: all checks passed');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(`entitlement-cap-probe failed: ${e?.message ?? e}`); process.exitCode = 1; });
