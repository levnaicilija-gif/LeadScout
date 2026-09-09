-- Verify could never have worked for a signed-in recruiter. Two RLS failures, both proven
-- against the live database by signing in as a real user and repeating what the route does:
--
--   1. storage.objects has RLS on and the three buckets had no policies at all, so every
--      upload returned "new row violates row-level security policy". The service role worked,
--      which is why nothing showed up in testing that used it.
--   2. ws_documents scopes a document through its candidate. Verify's whole point is that a
--      certificate arrives BEFORE the candidate exists, and a row with candidate_id = null
--      matches no candidate, so the insert was denied too.
--
-- Fix: give documents their own workspace, scope both tables on it, and add storage policies
-- keyed on the first path segment, which every route already writes as the workspace id.

-- ---------------------------------------------------------------- documents own their workspace
alter table documents add column if not exists workspace_id uuid references workspaces(id);
update documents d set workspace_id = c.workspace_id
  from candidates c where d.candidate_id = c.id and d.workspace_id is null;
create index if not exists documents_workspace_idx on documents (workspace_id);

drop policy if exists ws_documents on documents;
create policy ws_documents on documents for all using (
  workspace_id = my_workspace()
  or candidate_id in (select id from candidates where workspace_id = my_workspace())
);

-- Verifications follow their document, which now works for an unattached certificate.
drop policy if exists ws_verifications on verifications;
create policy ws_verifications on verifications for all using (
  document_id in (select id from documents where workspace_id = my_workspace()
                  or candidate_id in (select id from candidates where workspace_id = my_workspace()))
);

-- ---------------------------------------------------------------- storage
-- Every upload path in the app starts with the workspace id: "<workspace>/...". Scope on that.
-- Returns null rather than raising when the first segment is not a uuid: the screenshots
-- bucket also holds service-role paths like "radar/...", and a failed cast inside a policy
-- would error the whole query instead of just denying the row.
create or replace function storage_workspace(name text) returns uuid language plpgsql immutable as $$
declare v text := split_part(name, '/', 1);
begin
  if v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return v::uuid;
  end if;
  return null;
end $$;

do $$
declare b text;
begin
  foreach b in array array['documents','screenshots','pdfs'] loop
    execute format('drop policy if exists ws_storage_select_%1$s on storage.objects', b);
    execute format('drop policy if exists ws_storage_insert_%1$s on storage.objects', b);
    execute format('drop policy if exists ws_storage_update_%1$s on storage.objects', b);
    execute format($f$
      create policy ws_storage_select_%1$s on storage.objects for select to authenticated
      using (bucket_id = %1$L and storage_workspace(name) = my_workspace())
    $f$, b);
    execute format($f$
      create policy ws_storage_insert_%1$s on storage.objects for insert to authenticated
      with check (bucket_id = %1$L and storage_workspace(name) = my_workspace())
    $f$, b);
    execute format($f$
      create policy ws_storage_update_%1$s on storage.objects for update to authenticated
      using (bucket_id = %1$L and storage_workspace(name) = my_workspace())
    $f$, b);
  end loop;
end $$;
