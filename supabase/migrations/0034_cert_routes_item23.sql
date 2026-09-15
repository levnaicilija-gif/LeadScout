-- Item 23 (2026-09-15): the built-in confirmation routes, corrected to what each issuer's register actually offers today.
-- Data only — no table, column or policy changes. Every body keeps its row; only route, url, email and instructions move.
-- Checked live on 2026-09-15; the endpoints and evidence are in CLAUDE.md under "Item 23".
--
-- AMPP  issuer_email → register. ampp.org's old certification-search URL is a 404; its public registry at
--       nace.useclarus.com/view/verify/ is searchable without a login or captcha. It lists only current holders who
--       opted in, so a certificate that is not listed still goes to AMPP by email (the adapter says so, and the lookup
--       route drafts that email).
-- CSWIP stays register; TWI's own address for verification problems, printed on its page, goes on the row so a lookup
--       that cannot answer drafts an email to it.
-- IRATA register → issuer_email. Its verification tool sends a reCAPTCHA v3 token with every search. A person can use
--       it; this app does not automate past it. No IRATA address was confirmed, so none is set.
-- WINDA, CISRS: unchanged routes, instructions restated from the 2026-09-15 check.
-- electrical_dk: unchanged route; the instructions name the public company register, which lists companies only.

update cert_bodies set
  route = 'register',
  url = 'https://nace.useclarus.com/view/verify/',
  instructions = 'Searched automatically in AMPP''s public credential registry by certification number and surname. The registry lists only current holders who opted in, so a certificate that is not listed is not a verdict — we draft an email to AMPP for you to send.'
where workspace_id is null and body = 'ampp';

update cert_bodies set
  email = 'verification@twi.co.uk',
  instructions = 'Searched automatically on TWI''s CSWIP register by the candidate or certificate number and the holder''s date of birth, taken from the passport on file. When TWI cannot answer, we draft an email to verification@twi.co.uk for you to send.'
where workspace_id is null and body = 'cswip';

update cert_bodies set
  route = 'issuer_email',
  url = 'https://techconnect.irata.org/verify/tech',
  instructions = 'IRATA''s verification tool puts a reCAPTCHA in front of every search, so it is checked by hand: open techconnect.irata.org/verify/tech, enter the IRATA number and surname, and save the Verified Certification Report it offers.'
where workspace_id is null and body = 'irata';

update cert_bodies set
  instructions = 'WINDA records are visible only to organisations with a WINDA profile, using the WINDA ID the technician gives them — there is no public lookup. Ask the candidate for their WINDA ID and to share their record, or confirm with the training provider.'
where workspace_id is null and body = 'winda';

update cert_bodies set
  instructions = 'CISRS has no checker of its own, and both card checkers that cover it — CSCS Smart Check and NOCN''s Online Card Checker — put a captcha in front of every lookup, so it is checked by hand: registration number and surname in CSCS Smart Check, and save the screenshot.'
where workspace_id is null and body = 'cisrs';

update cert_bodies set
  instructions = 'Denmark authorises the company, not the electrician: Erhvervsstyrelsen''s public autorisationsregister (sik.dk/registre/autorisationsregister) lists authorised companies by CVR and authorisation number, and no individual. Confirm the employer''s authorisation there, and the electrician''s own qualification with the school or employer that issued it.'
where workspace_id is null and body = 'electrical_dk';

-- The certificate library's built-in "How it is checked" lines (cert_library.verification_route, seeded from
-- src/lib/certs/tables.ts by scripts/seed-certs.ts), restated to match the routes above. A workspace's own rows are not
-- touched. The screen showed "AMPP certification directory." and "IRATA — through the member company." beside the new
-- adapters' answers on 2026-09-15.
update cert_library set verification_route = 'TWI''s CSWIP register — by candidate or certificate number and the holder''s date of birth.'
where workspace_id is null and lang = 'en' and body = 'cswip' and level = '3.2';
update cert_library set verification_route = 'TWI''s CSWIP register — by number and date of birth.'
where workspace_id is null and lang = 'en' and body = 'cswip' and level in ('3.1', '3.0');
update cert_library set verification_route = 'AMPP''s public credential registry — lists current holders who opted in; not listed is not a verdict.'
where workspace_id is null and lang = 'en' and body = 'ampp';
update cert_library set verification_route = 'IRATA TechConnect — checked by hand: the tool puts a reCAPTCHA in front of every search.'
where workspace_id is null and lang = 'en' and body = 'irata' and level = '3';
update cert_library set verification_route = 'IRATA TechConnect — checked by hand (reCAPTCHA).'
where workspace_id is null and lang = 'en' and body = 'irata' and level in ('2', '1');
update cert_library set verification_route = 'CSCS Smart Check by registration number and surname — checked by hand (captcha).'
where workspace_id is null and lang = 'en' and body = 'cisrs';
