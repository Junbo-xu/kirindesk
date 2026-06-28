-- UP
-- Phase 2B: tenant self-service registration.
-- Adds a provenance marker so we can distinguish tenants that registered
-- themselves (anonymous public signup) from tenants a platform admin
-- provisioned. Used for audit/metrics and future abuse review; it is NOT a
-- security boundary (tenant isolation stays RLS-based).
--
--   * created_via: platform | self_signup. Existing rows default to
--     'platform' (they were all platform-provisioned), so no backfill is
--     needed and the NOT NULL DEFAULT is safe to add online.
--   * tenants has NO RLS (global registry), consistent with 003/036.
--   * plan_id already exists (038); free-plan binding at signup time is an
--     INSERT value, not a schema change.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS created_via text NOT NULL DEFAULT 'platform';

ALTER TABLE tenants ADD CONSTRAINT chk_tenants_created_via
  CHECK (created_via IN ('platform', 'self_signup'));

-- DOWN
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS chk_tenants_created_via;
ALTER TABLE tenants DROP COLUMN IF EXISTS created_via;
