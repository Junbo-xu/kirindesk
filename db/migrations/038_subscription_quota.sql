-- UP
-- Phase 1M: subscription plan binding + tenant quota usage snapshot.
--
--   * tenants gains plan_id (FK → plans, nullable; NULL = legacy tenant, treated
--     as 'standard' by QuotaGuard), plan_assigned_at, plan_expires_at (NULL =
--     perpetual). tenants has no RLS — same global-registry rule as 1K-A.
--   * tenant_quota_usage: one row per tenant, soft quota snapshot maintained by
--     the API layer (user_count / storage_bytes / ai_calls_month). FORCE RLS,
--     tenant_isolation policy. Row is provisioned by TenantOnboardingService
--     alongside the audit_log_chains genesis row. DELETE revoked — rows are
--     never removed, only updated.

ALTER TABLE tenants
  ADD COLUMN plan_id          uuid REFERENCES plans(id),
  ADD COLUMN plan_assigned_at timestamptz,
  ADD COLUMN plan_expires_at  timestamptz;  -- NULL = perpetual

CREATE INDEX idx_tenants_plan ON tenants (plan_id) WHERE plan_id IS NOT NULL;

CREATE TABLE tenant_quota_usage (
  tenant_id         uuid        PRIMARY KEY REFERENCES tenants(id),
  user_count        integer     NOT NULL DEFAULT 0,
  storage_bytes     bigint      NOT NULL DEFAULT 0,
  ai_calls_month    integer     NOT NULL DEFAULT 0,
  ai_calls_reset_at timestamptz NOT NULL DEFAULT date_trunc('month', now()),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_quota_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_quota_usage FORCE ROW LEVEL SECURITY;

CREATE POLICY tqu_tenant_isolation ON tenant_quota_usage
  FOR ALL
  USING      (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON tenant_quota_usage TO kirindesk_app;
REVOKE DELETE ON tenant_quota_usage FROM kirindesk_app;

-- DOWN
DROP TABLE IF EXISTS tenant_quota_usage;
DROP INDEX IF EXISTS idx_tenants_plan;
ALTER TABLE tenants
  DROP COLUMN IF EXISTS plan_expires_at,
  DROP COLUMN IF EXISTS plan_assigned_at,
  DROP COLUMN IF EXISTS plan_id;
