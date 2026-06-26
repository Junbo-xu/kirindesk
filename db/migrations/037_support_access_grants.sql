-- UP
-- Phase 1K-B: platform support access — customer-authorized, time-limited,
-- scoped, audited. See docs/phase-1k-b-support-access-plan.md §2.
--
-- One support_access_grants row = a tenant's explicit authorization for a NAMED
-- platform admin to read this tenant's data within a scope/time window. This is
-- a governance credential, NOT tenant business data.
--
-- Design notes (per plan §2):
--   * Tenant isolation via FORCE RLS keyed on app_current_tenant_id(), same as
--     every business table. The PLATFORM read path cannot use this RLS (it has
--     no tenant context at validation time), so a SECURITY DEFINER helper
--     (app_check_support_access) safely decides "does this admin hold a valid
--     active grant for this tenant?" without a tenant context — the same shape
--     as 028's anonymous file-token lookup.
--   * Lifecycle is expressed via status (pending/active/revoked/expired), never
--     a soft delete: revoke = an UPDATE that appends a status change, keeping the
--     full trail. Grants are write-once on their core terms — a freeze trigger
--     blocks edits to tenant/admin/scope/reason/expires_at/granted_by.
--   * DELETE is revoked (append-only-leaning governance record). UPDATE is kept
--     only for the status machine + revoke metadata.
--   * Validity is DERIVED at use time: status='active' AND now() < expires_at.
--     No background sweep flips expired grants; the read path trusts the
--     SECURITY DEFINER function, never status alone.
--   * NO audit_logs policy change: platform-access audit events reach the tenant
--     chain via the existing audit_logs_system_insert policy (021). See §2.6.

-- 1. support_access_grants — the customer-authorization credential.
CREATE TABLE support_access_grants (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  platform_admin_id   uuid NOT NULL REFERENCES platform_admins(id) ON DELETE RESTRICT,
  scope               varchar(20) NOT NULL,
  reason              text NOT NULL,
  status              varchar(20) NOT NULL DEFAULT 'pending',
  expires_at          timestamptz NOT NULL,
  granted_by_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_at         timestamptz,
  revoked_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at          timestamptz,
  revoke_reason       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- scope is an enumerated CHECK so future scopes are an explicit, reviewed add
  -- (§3.8), not a config flag. Only read_only exists this phase.
  CONSTRAINT chk_sag_scope CHECK (scope IN ('read_only')),
  CONSTRAINT chk_sag_status
    CHECK (status IN ('pending', 'active', 'revoked', 'expired'))
);

-- 2. RLS: tenant isolation (FORCE, same as every business table). The platform
-- read path does NOT rely on this — it uses app_check_support_access (step 7).
ALTER TABLE support_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_access_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY support_access_grants_tenant_select ON support_access_grants
  FOR SELECT
  USING (tenant_id = app_current_tenant_id());
CREATE POLICY support_access_grants_tenant_insert ON support_access_grants
  FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY support_access_grants_tenant_update ON support_access_grants
  FOR UPDATE
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- 3. Indexes.
CREATE INDEX idx_sag_tenant ON support_access_grants (tenant_id);
CREATE INDEX idx_sag_admin_status
  ON support_access_grants (platform_admin_id, status);
-- At most one live (active) grant per (admin, tenant): avoids ambiguous
-- duplicate authorizations (no-double-grant, mirrors 034's partial unique).
CREATE UNIQUE INDEX uq_sag_one_active
  ON support_access_grants (platform_admin_id, tenant_id)
  WHERE status = 'active';

-- 4. Grants: read/write but never hard-delete (the 000_app_role default grants
-- all four on new tables, so DELETE is explicitly revoked). Revoke is an UPDATE.
GRANT SELECT, INSERT, UPDATE ON support_access_grants TO kirindesk_app;
REVOKE DELETE ON support_access_grants FROM kirindesk_app;

-- 5. Freeze trigger: the authorization TERMS are write-once. tenant/admin/scope/
-- reason/expires_at/granted_by cannot be silently widened after the customer
-- authorized them; only status/approved_at/revoked_*/updated_at may advance
-- (the lifecycle). Mirrors 034's freeze-money-columns pattern.
CREATE OR REPLACE FUNCTION sag_freeze_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.platform_admin_id IS DISTINCT FROM OLD.platform_admin_id
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id THEN
    RAISE EXCEPTION 'support_access_grants authorization terms are immutable (only status/approval/revocation may change)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sag_freeze_immutable
  BEFORE UPDATE ON support_access_grants
  FOR EACH ROW EXECUTE FUNCTION sag_freeze_immutable();

-- 6. app_check_support_access — the per-request authorization check used by the
-- platform read path BEFORE any tenant context is set. SECURITY DEFINER reads
-- the table as owner (bypassing the caller's empty-context RLS) but returns ONLY
-- the grant id + scope for a VALID grant naming this exact admin+tenant. Validity
-- (status='active' AND now() < expires_at) is built in, so an expired grant is
-- never treated as valid even without a sweep. search_path pinned (029) to defeat
-- search_path hijacking.
CREATE OR REPLACE FUNCTION app_check_support_access(
  p_platform_admin_id uuid,
  p_tenant_id uuid
)
RETURNS TABLE (grant_id uuid, scope text)
AS $$
  SELECT id, scope
  FROM support_access_grants
  WHERE platform_admin_id = p_platform_admin_id
    AND tenant_id = p_tenant_id
    AND status = 'active'
    AND now() < expires_at
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION app_check_support_access(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_check_support_access(uuid, uuid) TO kirindesk_app;

-- 7. app_list_support_grants_for_admin — "which tenants named ME?" for the
-- platform admin's own-grants view (§3.6), also with no tenant context. Returns
-- ONLY the summary of grants naming this admin; never other admins' grants, never
-- business data. Same SECURITY DEFINER + pinned search_path hardening.
CREATE OR REPLACE FUNCTION app_list_support_grants_for_admin(
  p_platform_admin_id uuid
)
RETURNS TABLE (
  grant_id    uuid,
  tenant_id   uuid,
  scope       text,
  status      text,
  expires_at  timestamptz
)
AS $$
  SELECT id, tenant_id, scope, status, expires_at
  FROM support_access_grants
  WHERE platform_admin_id = p_platform_admin_id
  ORDER BY created_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION app_list_support_grants_for_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_list_support_grants_for_admin(uuid) TO kirindesk_app;

-- DOWN
-- Reverse dependency order; purely additive migration, so a clean drop. Does NOT
-- touch audit_logs (no policy added) or tenants (its status CHECK belongs to 036).
DROP FUNCTION IF EXISTS app_list_support_grants_for_admin(uuid);
DROP FUNCTION IF EXISTS app_check_support_access(uuid, uuid);
DROP TRIGGER IF EXISTS trg_sag_freeze_immutable ON support_access_grants;
DROP FUNCTION IF EXISTS sag_freeze_immutable();
DROP TABLE IF EXISTS support_access_grants CASCADE;
