import { NextResponse } from 'next/server';
import { supabaseServer, supabaseAdmin, currentUser } from '@/lib/supabase/server';
import { jdFromLead, screeningQuestions, draftOutreachChecked, scoreWithRightToWork, anonymize } from '@/lib/ai/documents';
import { searchCountriesFor, checkRightToWork } from '@/lib/right-to-work';
import { xrayCandidatesUrl, xrayLocalVariantUrl, linkedinSearchUrl, googleSearchUrl } from '@/lib/search-urls';
import { hasRightToWork, hasCandidateCountries, hasHiringState, hasCompanyOutreach, hasPostingContact } from '@/lib/schema-features';
import { buildSheet, fromAttendeeList, type FoundContact } from '@/lib/hiring-contacts';
import { sendCapability } from '@/lib/send-capability';
export const maxDuration = 120;

/**
 * Everything a recruiter can do to a Hiring now row, without a lead having to exist.
 *
 * A lead is something a recruiter decides to create; a posting is a fact about a company read
 * this morning. So this route works on the company and its open postings, and the only thing
 * that turns one into a decision is the recruiter pressing Pursue.
 *
 *   POST { company_id, action: 'sheet' | 'jd' | 'questions' | 'xray' | 'score_pool'
 *                             | 'draft' | 'confirm' | 'status' }
 */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  const sb = supabaseServer();
  const b = await req.json();

  const withContact = await hasPostingContact(sb);
  const contactCols = withContact ? ', contact_name, contact_title, contact_email, contact_phone' : '';
  const { data: co } = await sb.from('companies').select('*').eq('id', b.company_id).maybeSingle();
  if (!co) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // The column list is built at runtime because the contact columns arrive with 0020, so the
  // select is cast: Supabase's type parser cannot read a template literal.
  const postSelect = `id, title, role, location, country, trades, certs_required, rotation, contract_type, headcount, posted_at, first_seen_at, source_url, via${contactCols}`;
  const { data: posts } = await sb.from('job_posts')
    .select(postSelect as '*')
    .eq('company_id', co.id).eq('status', 'open')
    .order('posted_at', { ascending: false, nullsFirst: false })
    .limit(60) as { data: any[] | null };
  const postings = posts ?? [];
  if (!postings.length && b.action !== 'status') {
    return NextResponse.json({ error: 'This company has no open postings any more.' }, { status: 400 });
  }

  const trades = [...new Set(postings.flatMap((p: any) => p.trades ?? []))];
  const certs = [...new Set(postings.flatMap((p: any) => p.certs_required ?? []))];
  const country = postings.find((p: any) => p.country)?.country ?? co.country ?? null;
  const places = [...new Set(postings.map((p: any) => p.location).filter(Boolean))];

  /** The adverts themselves, as the source text every tool reads from. */
  const postingText = postings.map((p: any) =>
    [`Role: ${p.role ?? p.title ?? 'trade role'}`,
     p.location && `Location: ${p.location}`,
     p.headcount && `Headcount: ${p.headcount}`,
     p.rotation && `Rotation: ${p.rotation}`,
     p.contract_type && `Contract: ${p.contract_type}`,
     p.certs_required?.length && `Certificates asked for: ${p.certs_required.join(', ')}`,
     p.posted_at && `Posted: ${p.posted_at}`,
     `Source: ${p.source_url}`].filter(Boolean).join('\n')).join('\n\n');

  switch (b.action) {
    /* ------------------------------------------------ who to contact */
    case 'sheet': {
      const postingContacts: FoundContact[] = postings
        .filter((p: any) => p.contact_name)
        .map((p: any) => ({
          name: p.contact_name, title: p.contact_title, email: p.contact_email, phone: p.contact_phone,
          emailStatus: p.contact_email ? 'found' as const : 'unknown' as const,
          sourceUrl: p.source_url, readAt: p.first_seen_at ?? '', where: 'posting' as const,
          linkedinSearchUrl: linkedinSearchUrl(p.contact_name, co.name),
          googleSearchUrl: googleSearchUrl(p.contact_name, co.name),
        }));

      // Anyone read off the company's own organisation or leadership page. contacts.lead_id is
      // nullable, so these hang from the company with no lead invented for them.
      const { data: onFile } = await sb.from('contacts')
        .select('name, title, email, email_status, email_source_url, phone, phone_source_url, source_url, linkedin_search_url, google_search_url, found_at')
        .eq('company_id', co.id).limit(10);
      const orgContacts: FoundContact[] = (onFile ?? [])
        .filter((c: any) => c.source_url)
        .map((c: any) => ({
          name: c.name, title: c.title, email: c.email, phone: c.phone,
          emailStatus: (c.email_status ?? 'unknown') as any,
          sourceUrl: c.email_source_url ?? c.source_url,
          readAt: c.found_at ?? '',
          where: 'organisation page' as const,
          linkedinSearchUrl: c.linkedin_search_url ?? undefined,
          googleSearchUrl: c.google_search_url ?? undefined,
        }));

      const { data: people } = await sb.from('people')
        .select('name, title, source, company_name')
        .eq('workspace_id', me.workspace_id)
        .ilike('company_name', `%${co.name.split(' ')[0]}%`)
        .limit(25);

      const sheet = buildSheet({
        companyName: co.name,
        postingContacts,
        orgContacts,
        attendees: fromAttendeeList(people ?? [], co.name),
        switchboard: co.switchboard, switchboardSource: co.switchboard_source_url,
        generalEmail: co.general_email, generalEmailSource: co.general_email_source_url,
      });

      // Right to work is a property of where the work is, not of who we happen to have.
      const rtw = checkRightToWork(country, { eu_passport: undefined, uk_right_to_work: undefined } as any);
      return NextResponse.json({ sheet, country, rule: rtw.rule, checkedAt: co.contacts_checked_at ?? null });
    }

    /* ------------------------------------------------------ the tools */
    case 'jd': {
      const jd = await jdFromLead({
        company: co.name, employer_type: co.employer_type_override ?? co.employer_type,
        location: places.join(', ') || country, trades,
        certificates_asked_for: certs,
        open_roles: postings.map((p: any) => ({ role: p.role ?? p.title, headcount: p.headcount, rotation: p.rotation })),
      }, postingText);
      return NextResponse.json(jd);
    }

    case 'questions': {
      if (!b.job_description) return NextResponse.json({ error: 'Write the job description first — the questions come from it.' }, { status: 400 });
      return NextResponse.json(await screeningQuestions(b.job_description));
    }

    case 'xray': {
      // Countries follow the job. Serbia was the old default and is wrong for any EU or UK
      // posting: a Serbian welder needs a permit nobody sponsors for a short scope.
      const { data: ws } = (await hasCandidateCountries(sb))
        ? await sb.from('workspaces').select('candidate_countries').eq('id', me.workspace_id).maybeSingle()
        : { data: null as any };
      const countries: string[] = b.countries?.length ? b.countries : searchCountriesFor(country, ws?.candidate_countries ?? []);
      const roles = trades.length ? trades : ['welder'];
      const wanted = certs.length ? certs : ['ISO 9606', 'FROSIO', 'PCN', 'IRATA'];
      return NextResponse.json({
        url: xrayCandidatesUrl({ roles, certs: wanted, sectors: ['offshore', 'shipyard', 'North Sea', 'oil and gas'], countries }),
        localUrl: xrayLocalVariantUrl({ roles, certs: wanted, countries }, country),
        countries, jobCountry: country,
      });
    }

    case 'score_pool': {
      if (!b.job_description) return NextResponse.json({ error: 'Write the job description first — the score is against it.' }, { status: 400 });
      const cols = `id, reference_code, profile${(await hasRightToWork(sb)) ? ', nationality, eu_passport, uk_right_to_work, uk_right_to_work_basis' : ''}`;
      const { data: cands } = await sb.from('candidates').select(cols as '*')
        .eq('workspace_id', me.workspace_id).limit(60) as { data: any[] | null };
      const out = [];
      for (const c of cands ?? []) {
        const s = await scoreWithRightToWork(anonymize(c.profile as any), [], b.job_description, country, c as any);
        out.push({ ...c, ...s });
      }
      return NextResponse.json({
        ranked: out.sort((a, b2) => (a.blockers.length ? 1 : 0) - (b2.blockers.length ? 1 : 0) || b2.score - a.score).slice(0, 10),
      });
    }

    /* -------------------------------------------------- the approach */
    case 'draft': {
      if (!co.hiring_confirmed_at && (await hasHiringState(sb))) {
        return NextResponse.json({ error: 'Confirm you have looked at the board before drafting an approach.' }, { status: 400 });
      }
      // What we actually hold. Only verified certificates reach the draft, and checkDraft
      // rejects any claim about our people that the pool does not support.
      const { data: verified } = await sb.from('verifications')
        .select('result, valid_until, documents!inner(cert_body, extracted, candidates!candidate_id(reference_code, trade))')
        .eq('result', 'valid').limit(40);
      const { data: available } = await sb.from('candidates')
        .select('id, trade', { count: 'exact' })
        .eq('workspace_id', me.workspace_id)
        .or(`availability_from.is.null,availability_from.lte.${new Date().toISOString().slice(0, 10)}`)
        .limit(100);

      const pool = {
        available: (available ?? []).length,
        available_by_trade: Object.entries((available ?? []).reduce((a: any, c: any) => { const k = c.trade ?? 'unstated'; a[k] = (a[k] ?? 0) + 1; return a; }, {})).map(([trade, n]) => ({ trade, n })),
        verified_certificates: (verified ?? []).map((v: any) => ({
          body: v.documents?.cert_body, level: v.documents?.extracted?.level ?? null, valid_until: v.valid_until,
        })),
        projects: [],
      };

      const contactName = postings.find((p: any) => p.contact_name)?.contact_name ?? null;
      const contactTitle = postings.find((p: any) => p.contact_name)?.contact_title ?? null;

      const d = await draftOutreachChecked({
        company: co.name,
        employer_type: co.employer_type_override ?? co.employer_type,
        what_they_are_hiring: postings.map((p: any) => ({ role: p.role ?? p.title, location: p.location, headcount: p.headcount, certs: p.certs_required })),
        where: places.join(', ') || country,
        certificates_asked_for: certs,
        posting_source: postings[0]?.source_url,
        recipient: contactName ? { name: contactName, title: contactTitle } : { name: null, title: 'whoever books the trades' },
        hook: null,
        offer: 'manpower supply — verified, anonymised candidates ready to send',
        pool,
      });

      // Recorded as a draft against the company and the adverts it answers, so six months later
      // the question "which postings was this about" has an answer.
      let outreachId: string | null = null;
      if (await hasCompanyOutreach(sb)) {
        const admin = supabaseAdmin();
        const { data: row } = await admin.from('outreach').insert({
          company_id: co.id, channel: 'email', subject: d.subject, body: d.email,
          reasoning: d.reasoning, job_post_ids: postings.map((p: any) => p.id), status: 'draft',
        }).select('id').maybeSingle();
        outreachId = row?.id ?? null;
      }

      const cap = await sendCapability();
      return NextResponse.json({
        ...d,
        outreachId,
        to: postings.find((p: any) => p.contact_email)?.contact_email ?? co.general_email ?? null,
        toStatus: postings.some((p: any) => p.contact_email) ? 'found' : co.general_email ? 'found' : 'unknown',
        send: cap,
      });
    }

    /* ------------------------------------------------- row decisions */
    case 'confirm': {
      if (!(await hasHiringState(sb))) return NextResponse.json({ error: 'Migration 0020 has not been applied yet.' }, { status: 503 });
      await supabaseAdmin().from('companies')
        .update({ hiring_confirmed_at: new Date().toISOString(), hiring_confirmed_by: me.id })
        .eq('id', co.id);
      return NextResponse.json({ ok: true });
    }

    case 'status': {
      if (!(await hasHiringState(sb))) return NextResponse.json({ error: 'Migration 0020 has not been applied yet.' }, { status: 503 });
      if (!['new', 'pursued', 'not_for_us'].includes(b.status)) return NextResponse.json({ error: 'unknown status' }, { status: 400 });
      await supabaseAdmin().from('companies')
        .update({ hiring_status: b.status, hiring_status_at: new Date().toISOString(), hiring_status_by: me.id })
        .eq('id', co.id);
      return NextResponse.json({ ok: true, status: b.status });
    }

    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }
}
