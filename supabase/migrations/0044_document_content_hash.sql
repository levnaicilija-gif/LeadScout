-- 0044 — the content hash of a stored document.
--
-- WHY. Item 24's duplicate rule compares a NAME plus a second field (email, phone, date of birth),
-- which is the right rule for "is this the same person" and cannot answer "is this the same file".
-- On 2026-09-22 the same CV was dropped twice, 85 seconds apart, and became RFBT-P-0625 and
-- RFBT-P-0626: byte for byte identical, sha256 358e9c00…, 84,293 bytes both times. A content hash
-- is the one signal with no judgement in it at all — not "these look alike" but "this is the file
-- you already have, on #N" — and nothing in the app could see it, because the digest in
-- storage_path is of the FILE NAME (storage-path.ts), never of the bytes.
--
-- Nullable and unbackfilled on purpose. Existing rows keep null, which reads as "we never hashed
-- this one" rather than "this one is different"; scripts/backfill-document-hashes.ts fills them by
-- re-reading each stored object. A null must never be compared as if it were a hash.
--
-- NOT unique, and deliberately so. The same file legitimately appears twice: a certificate that
-- belongs to two people cannot, but a blank template, a scanned form or a CV re-sent by an agency
-- can, and a unique index would refuse the upload outright instead of letting a recruiter decide.
-- The index exists to make the lookup cheap, not to enforce anything.

alter table documents add column if not exists content_sha256 text;

create index if not exists documents_content_sha256_idx
  on documents (workspace_id, content_sha256)
  where content_sha256 is not null;

comment on column documents.content_sha256 is
  'sha256 of the stored bytes, for "this is the same file you already have". Null means never hashed, never "different". Not unique: the same file can legitimately belong to two records.';
