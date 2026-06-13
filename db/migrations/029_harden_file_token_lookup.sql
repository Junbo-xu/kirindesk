-- UP
-- Harden the SECURITY DEFINER helper from migration 028 by pinning search_path.
-- A SECURITY DEFINER function runs as its owner (the migration superuser) with
-- RLS bypassed; without a fixed search_path, anyone who can create objects in a
-- schema earlier on the resolution path could shadow `file_access_tokens` and
-- hijack the lookup. kirindesk_app currently lacks CREATE on public (verified),
-- so present risk is low, but pinning search_path is the standard defense-in-
-- depth for SECURITY DEFINER and removes the latent footgun if grants change.
--
-- pg_temp is placed LAST intentionally: it is always implicitly searched first
-- by Postgres, but listing it last in an explicit search_path makes it lowest
-- priority for resolution, so a session-temp object cannot shadow public.
CREATE OR REPLACE FUNCTION app_lookup_file_token(p_token_hash varchar)
RETURNS TABLE (tenant_id uuid, created_by uuid)
AS $$
  SELECT tenant_id, created_by FROM file_access_tokens WHERE token_hash = p_token_hash;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

GRANT EXECUTE ON FUNCTION app_lookup_file_token(varchar) TO kirindesk_app;

-- DOWN
-- Revert to the un-pinned definition from migration 028 (idempotent CREATE OR
-- REPLACE; the function itself is not dropped, only its search_path setting is
-- removed). Re-grant to preserve execute privilege after the replace.
CREATE OR REPLACE FUNCTION app_lookup_file_token(p_token_hash varchar)
RETURNS TABLE (tenant_id uuid, created_by uuid)
AS $$
  SELECT tenant_id, created_by FROM file_access_tokens WHERE token_hash = p_token_hash;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION app_lookup_file_token(varchar) TO kirindesk_app;
