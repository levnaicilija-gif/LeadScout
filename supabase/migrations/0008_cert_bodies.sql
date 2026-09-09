-- Certificates by route.
--
-- Until now the adapter list decided everything, so a body with no online register came back
-- as "not_supported — manual check", which tells a recruiter nothing about what to do. A
-- certificate body has a ROUTE (how it can be confirmed at all) and every check ends in a
-- STATE (how far that confirmation got). Both are data, so a new body is a row, not a deploy.

create table if not exists cert_bodies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id),      -- null = built-in, shared by every workspace
  body text not null,                               -- matches documents.cert_body
  name text not null,
  route text not null check (route in ('register', 'credential_link', 'issuer_email', 'candidate_share', 'unsupported')),
  url text,                                         -- register or checker to open by hand
  email text,                                       -- issuer address for the email route
  instructions text not null,                       -- what the recruiter should do, in plain words
  adapter text,                                     -- src/lib/verify/adapters key, when one exists
  created_at timestamptz default now(),
  unique (workspace_id, body)
);
create unique index if not exists cert_bodies_builtin_uidx on cert_bodies (body) where workspace_id is null;

alter table cert_bodies enable row level security;
-- Built-in rows are readable by everyone; a workspace may add or override its own.
create policy ws_cert_bodies_read on cert_bodies for select using (workspace_id is null or workspace_id = my_workspace());
create policy ws_cert_bodies_write on cert_bodies for all using (workspace_id = my_workspace());

-- The state a check ended in, distinct from what the document says.
alter table verifications add column if not exists state text;
alter table verifications add column if not exists route text;
alter table documents add column if not exists cert_state text;

comment on column verifications.state is
  'verified_register | verified_credential | confirmed_by_issuer | consistent_with_test_report | pending_issuer | awaiting_candidate_share | unsupported';

-- ---------------------------------------------------------------- built-in routes
insert into cert_bodies (workspace_id, body, name, route, url, email, instructions, adapter) values
  (null, 'pcn', 'PCN — BINDT', 'register',
   'https://www.bindt.org/Certification/pcn-certificate-verification/', null,
   'Searched automatically on the BINDT register by PCN number, or by surname when the number is not a PCN number.', 'pcn'),

  (null, 'cswip', 'CSWIP / BGAS-CSWIP — TWI Certification', 'register',
   'https://www.cswip.com/verification', null,
   'Searched automatically. CSWIP verifies on certificate number AND date of birth, so the passport must be on file first.', 'cswip'),

  (null, 'irata', 'IRATA International', 'register',
   'https://irata.org/verify/', null,
   'Searched automatically on IRATA TechConnect using the IRATA number and surname. The tool is behind a reCAPTCHA, so this one needs a hosted browser.', 'irata'),

  (null, 'frosio', 'FROSIO', 'credential_link',
   'https://frosio.no/en/', 'frosio@frosio.no',
   'FROSIO has no public register. If the certificate carries an Accredible credential link or QR code we read that page; otherwise we draft an email to FROSIO for you to send.', 'frosio'),

  (null, 'ampp', 'AMPP (formerly NACE/SSPC)', 'issuer_email',
   'https://www.ampp.org/resources/impact/certification-search', 'customersupport@ampp.org',
   'The AMPP certification search needs an AMPP account, so there is no anonymous lookup. We draft an email to AMPP support for you to send.', 'ampp'),

  (null, 'winda', 'GWO / WINDA', 'candidate_share',
   'https://winda.globalwindsafety.org/', null,
   'WINDA records are visible only to the technician and to organisations they grant access to. Ask the candidate to share their WINDA record or add RFBT as an organisation.', 'winda'),

  (null, 'cisrs', 'CISRS — checked via CSCS Smart Check', 'candidate_share',
   'https://www.cscssmartcheck.co.uk/', 'enquiries@cisrs.org.uk',
   'CISRS has no checker of its own and CSCS Smart Check puts a reCAPTCHA in front of every lookup. Check the card in the CSCS Smart Check app and save the screenshot.', 'cisrs'),

  (null, 'electrical_dk', 'Danish electrical authorisation — Sikkerhedsstyrelsen', 'issuer_email',
   'https://www.sik.dk/erhverv/elinstallationer-og-elanlaeg/autorisation', null,
   'Denmark authorises the company, not the individual, so there is no personal register. Confirm the employer''s authorisation and treat the qualification as a trade certificate.', 'electrical_dk'),

  (null, 'iso9606', 'Welder qualification ISO 9606 — issuer', 'issuer_email',
   null, null,
   'No public register exists for welder qualifications. With the test report on file and consistent, the certificate can go in a pack labelled as such while the issuer confirms by email.', null),

  (null, 'dnv', 'DNV', 'issuer_email', 'https://www.dnv.com/', 'certification@dnv.com',
   'DNV publishes no personnel register. We draft a verification email to the issuing office for you to send.', null),

  (null, 'bv', 'Bureau Veritas', 'issuer_email', 'https://www.bureauveritas.com/', 'certification@bureauveritas.com',
   'Bureau Veritas publishes no personnel register. We draft a verification email to the issuing office for you to send.', null),

  (null, 'tuv_sud', 'TÜV SÜD', 'issuer_email', 'https://www.tuvsud.com/', 'info@tuvsud.com',
   'TÜV SÜD publishes no personnel register. We draft a verification email to the issuing office for you to send.', null),

  (null, 'tuv_nord', 'TÜV NORD', 'issuer_email', 'https://www.tuv-nord.com/', 'info@tuv-nord.com',
   'TÜV NORD publishes no personnel register. We draft a verification email to the issuing office for you to send.', null),

  (null, 'tuv_rheinland', 'TÜV Rheinland', 'issuer_email', 'https://www.tuv.com/', 'info@de.tuv.com',
   'TÜV Rheinland publishes no personnel register. We draft a verification email to the issuing office for you to send.', null),

  (null, 'lrqa', 'LRQA (Lloyd''s Register)', 'issuer_email', 'https://www.lrqa.com/', 'enquiries@lrqa.com',
   'LRQA publishes no personnel register. We draft a verification email to the issuing office for you to send.', null)
on conflict do nothing;
