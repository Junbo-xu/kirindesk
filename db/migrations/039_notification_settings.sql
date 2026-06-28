-- UP
-- Phase 1N: per-tenant email notification preferences.
--
--   * tenant_notification_settings: one row per tenant, created by
--     TenantOnboardingService alongside the quota_usage genesis row.
--     FORCE RLS — tenant_isolation policy. DELETE revoked.

CREATE TABLE tenant_notification_settings (
  tenant_id      uuid        PRIMARY KEY REFERENCES tenants(id),
  order_events   boolean     NOT NULL DEFAULT true,
  user_welcome   boolean     NOT NULL DEFAULT true,
  support_access boolean     NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_notification_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY tns_tenant_isolation ON tenant_notification_settings
  FOR ALL
  USING      (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON tenant_notification_settings TO kirindesk_app;
REVOKE DELETE ON tenant_notification_settings FROM kirindesk_app;

-- DOWN
DROP TABLE IF EXISTS tenant_notification_settings;
