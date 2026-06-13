-- UP
-- Backfill the user foreign keys that 017/018 deferred. files.uploaded_by and
-- file_access_tokens.created_by reference users(id); ON DELETE RESTRICT keeps
-- audit provenance intact (a user with uploaded files cannot be hard-deleted).
ALTER TABLE files
  ADD CONSTRAINT files_uploaded_by_fkey
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE file_access_tokens
  ADD CONSTRAINT file_access_tokens_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;

-- Anonymous download endpoint bootstrap. file_access_tokens has FORCE RLS keyed
-- on app_current_tenant_id(), but the download caller is anonymous and the
-- tenant_id lives inside the token row (chicken/egg). This SECURITY DEFINER
-- helper resolves ONLY tenant_id + created_by from the unguessable token_hash,
-- bypassing RLS for that single narrow lookup. The caller then sets that tenant
-- context and re-validates/claims the token under normal RLS. The function
-- discloses nothing without a valid 32-byte token hash.
CREATE OR REPLACE FUNCTION app_lookup_file_token(p_token_hash varchar)
RETURNS TABLE (tenant_id uuid, created_by uuid)
AS $$
  SELECT tenant_id, created_by FROM file_access_tokens WHERE token_hash = p_token_hash;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION app_lookup_file_token(varchar) TO kirindesk_app;

-- DOWN
-- DROP FUNCTION removes its grants too, so no explicit REVOKE (which would
-- error if the function was never created).
DROP FUNCTION IF EXISTS app_lookup_file_token(varchar);
ALTER TABLE file_access_tokens DROP CONSTRAINT IF EXISTS file_access_tokens_created_by_fkey;
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_uploaded_by_fkey;
