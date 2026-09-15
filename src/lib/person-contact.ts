import type { SupabaseClient } from '@supabase/supabase-js';
import { linkedinSearchUrl, googleSearchUrl } from '@/lib/search-urls';
import type { PersonOnPage } from '@/lib/person-on-site';

/**
 * Keep a person read off a company's own page as a contact on that company (lead_id null, as the organisation-page
 * pass stores them), with the page as the source of the address and the number.
 *
 * A contact already on file under that name only gains what it lacks: an address or number that was confirmed
 * once is never replaced by one read somewhere else. The title printed on the page wins over the attendee list's.
 */
export async function recordPersonContact(
  db: SupabaseClient, companyId: string, companyName: string, hit: PersonOnPage, listTitle: string | null,
): Promise<'stored' | 'updated' | 'unchanged'> {
  const { data: already, error: readError } = await db.from('contacts').select('id, email, phone').eq('company_id', companyId).ilike('name', hit.name).limit(1);
  if (readError) throw new Error(`contacts at ${companyName} could not be read: ${readError.message}`);
  const e = already?.[0];
  if (e) {
    const patch: Record<string, unknown> = {};
    if (!e.email) Object.assign(patch, { email: hit.email, email_status: 'found', email_source_url: hit.url });
    if (!e.phone && hit.phone) Object.assign(patch, { phone: hit.phone, phone_source_url: hit.url });
    if (!Object.keys(patch).length) return 'unchanged';
    const { error } = await db.from('contacts').update(patch).eq('id', e.id);
    if (error) throw new Error(`contact update failed at ${companyName}: ${error.message}`);
    return 'updated';
  }
  const { error } = await db.from('contacts').insert({
    company_id: companyId, lead_id: null, name: hit.name, title: hit.title ?? listTitle ?? 'title not printed',
    email: hit.email, email_status: 'found', email_source_url: hit.url,
    phone: hit.phone, phone_source_url: hit.phone ? hit.url : null, source_url: hit.url,
    linkedin_search_url: linkedinSearchUrl(hit.name, companyName), google_search_url: googleSearchUrl(hit.name, companyName),
  });
  if (error) throw new Error(`contact insert failed at ${companyName}: ${error.message}`);
  return 'stored';
}

/**
 * Item 21: the person a news story quoted, found by name on their company's own site. They gain only the address or
 * number they lack, with the page as its source — the quoted contact is never replaced, renamed or re-titled, and an
 * address already on file is never overwritten by one read somewhere else.
 */
export async function addToQuotedContact(
  db: SupabaseClient, contactId: string, companyName: string, hit: PersonOnPage,
): Promise<'updated' | 'unchanged'> {
  const { data: row, error: readError } = await db.from('contacts').select('id, email, phone').eq('id', contactId).maybeSingle();
  if (readError) throw new Error(`the quoted contact at ${companyName} could not be read: ${readError.message}`);
  if (!row) return 'unchanged';
  const patch: Record<string, unknown> = {};
  if (!row.email) Object.assign(patch, { email: hit.email, email_status: 'found', email_source_url: hit.url });
  if (!row.phone && hit.phone) Object.assign(patch, { phone: hit.phone, phone_source_url: hit.url });
  if (!Object.keys(patch).length) return 'unchanged';
  const { error } = await db.from('contacts').update(patch).eq('id', contactId);
  if (error) throw new Error(`the quoted contact at ${companyName} could not be updated: ${error.message}`);
  return 'updated';
}
