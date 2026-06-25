-- UP
-- Phase 1K-A: tenant lifecycle.
-- The tenants.status column already exists (003) and defaults to 'active'.
-- This migration adds the suspension metadata columns and an explicit status
-- CHECK so the lifecycle states are DB-enforced, not just app-level.
--
--   * status state set: active | suspended | deactivated. The global tenant-
--     status gate (TenantStatusMiddleware) blocks every non-'active' state for
--     tenant users; only the platform can change status.
--   * suspended_at / suspended_reason capture the most-recent non-active
--     transition (suspend OR deactivate) and are cleared on activate. Full
--     status-change history lives in the audit log (tenant.suspended/.activated/
--     .deactivated), so no separate history table.
--   * Additive + safe: existing rows are all 'active', so the CHECK needs no
--     backfill and the new columns are nullable.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_reason text;

ALTER TABLE tenants ADD CONSTRAINT chk_tenants_status
  CHECK (status IN ('active', 'suspended', 'deactivated'));

-- DOWN
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS chk_tenants_status;
ALTER TABLE tenants DROP COLUMN IF EXISTS suspended_reason;
ALTER TABLE tenants DROP COLUMN IF EXISTS suspended_at;
