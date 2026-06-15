-- UP
-- Phase 1F-F: commission payout / disbursement.
-- Turns a locked 1F-E commission_settlement into a tracked disbursement record.
-- See docs/phase-1f-f-commission-payout-plan.md §2 / §3 / §4.
--
-- Design notes (per plan):
--   * One batch header (commission_payouts) + per-salesperson lines
--     (commission_payout_lines), mirroring the 1F-E settlement header/line split.
--   * Amounts are COPIED from commission_settlement_lines at creation and are
--     immutable thereafter (§3 D1/D7). A BEFORE UPDATE trigger freezes the money
--     columns; only status/metadata columns may change in place.
--   * Unlike the append-only settlement tables, payouts keep UPDATE for the
--     status machine (open->paid->void / pending->paid->void, §3 D3/D4). No
--     DELETE: reversal is void-in-place, never a hard delete.
--   * At most one live (non-void) payout per settlement, enforced by a partial
--     unique index — the DB-level no-double-pay guard (§3 D5).
--   * Money is numeric(18,2) in the tenant base currency, copied from the
--     settlement; no FX, no second currency (§9).

-- 1. commission_payouts — the disbursement batch header (one per settlement)
CREATE TABLE commission_payouts (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  settlement_id      uuid NOT NULL REFERENCES commission_settlements(id),
  status             varchar(16) NOT NULL DEFAULT 'open',
  total_payout_base  numeric(18, 2) NOT NULL,
  currency           varchar(8) NOT NULL,
  payout_date        date,
  external_ref       varchar(128),
  note               varchar(500),
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  paid_by            uuid REFERENCES users(id),
  paid_at            timestamptz,
  voided_by          uuid REFERENCES users(id),
  voided_at          timestamptz,
  void_reason        varchar(500),
  CONSTRAINT chk_commission_payouts_status
    CHECK (status IN ('open', 'paid', 'void')),
  CONSTRAINT chk_commission_payouts_total CHECK (total_payout_base >= 0),
  -- void must carry a reason (§3 D4); paid must carry actor + timestamp.
  CONSTRAINT chk_commission_payouts_void
    CHECK (status <> 'void' OR void_reason IS NOT NULL),
  CONSTRAINT chk_commission_payouts_paid
    CHECK (status <> 'paid' OR (paid_by IS NOT NULL AND paid_at IS NOT NULL))
);

-- 2. commission_payout_lines — one row per salesperson in the batch
CREATE TABLE commission_payout_lines (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  payout_id            uuid NOT NULL REFERENCES commission_payouts(id) ON DELETE CASCADE,
  settlement_line_id   uuid NOT NULL REFERENCES commission_settlement_lines(id),
  salesperson_user_id  uuid NOT NULL REFERENCES users(id),
  amount_base          numeric(18, 2) NOT NULL,
  status               varchar(16) NOT NULL DEFAULT 'pending',
  paid_at              timestamptz,
  CONSTRAINT chk_commission_payout_lines_status
    CHECK (status IN ('pending', 'paid', 'void')),
  CONSTRAINT chk_commission_payout_lines_amount CHECK (amount_base >= 0),
  CONSTRAINT uq_commission_payout_lines_person
    UNIQUE (payout_id, salesperson_user_id)
);

-- Indexes (tenant_id leads to align with the RLS predicate).
CREATE INDEX idx_commission_payouts_tenant
  ON commission_payouts (tenant_id, settlement_id);

-- No-double-pay: at most one live (non-void) payout per settlement (§3 D5).
-- Scoped to settlement_id only (a PK, already globally unique); RLS still
-- isolates by tenant.
CREATE UNIQUE INDEX uq_commission_payouts_live_settlement
  ON commission_payouts (settlement_id)
  WHERE status <> 'void';

CREATE INDEX idx_commission_payout_lines_payout
  ON commission_payout_lines (tenant_id, payout_id);
CREATE INDEX idx_commission_payout_lines_person
  ON commission_payout_lines (tenant_id, salesperson_user_id);

-- RLS: tenant isolation on both tables (same policy as every tenant table).
ALTER TABLE commission_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_payouts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON commission_payouts
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE commission_payout_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_payout_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON commission_payout_lines
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Grants. Unlike the append-only settlement tables (SELECT, INSERT only), the
-- payout tables keep UPDATE for the in-place status machine (§2.3 / §3 D4).
-- DELETE is revoked: reversal is void-in-place, never a hard delete. The
-- 000_app_role.sql default grants all four on every new table, so DELETE is
-- explicitly revoked here.
GRANT SELECT, INSERT, UPDATE ON commission_payouts, commission_payout_lines TO kirindesk_app;
REVOKE DELETE ON commission_payouts, commission_payout_lines FROM kirindesk_app;

-- Freeze-money-columns trigger (§3 D7). A disbursed amount is copied from a
-- locked settlement and frozen. UPDATE is granted for the status machine, so
-- this trigger is what makes the money columns write-once at the DB level.
CREATE OR REPLACE FUNCTION prevent_commission_payout_amount_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.total_payout_base IS DISTINCT FROM OLD.total_payout_base THEN
    RAISE EXCEPTION 'commission_payouts.total_payout_base is immutable after creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER freeze_commission_payout_amount
  BEFORE UPDATE ON commission_payouts
  FOR EACH ROW EXECUTE FUNCTION prevent_commission_payout_amount_change();

CREATE OR REPLACE FUNCTION prevent_commission_payout_line_amount_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.amount_base IS DISTINCT FROM OLD.amount_base THEN
    RAISE EXCEPTION 'commission_payout_lines.amount_base is immutable after creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER freeze_commission_payout_line_amount
  BEFORE UPDATE ON commission_payout_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_commission_payout_line_amount_change();

-- DOWN
-- Reverse dependency order: triggers/functions, then children before parents.
-- Purely additive migration (no altered columns, no coerced data), so the down
-- is a clean drop. CASCADE clears the RLS policies, indexes, and FKs with their
-- tables.
DROP TRIGGER IF EXISTS freeze_commission_payout_line_amount ON commission_payout_lines;
DROP TRIGGER IF EXISTS freeze_commission_payout_amount ON commission_payouts;
DROP FUNCTION IF EXISTS prevent_commission_payout_line_amount_change();
DROP FUNCTION IF EXISTS prevent_commission_payout_amount_change();
DROP TABLE IF EXISTS commission_payout_lines CASCADE;
DROP TABLE IF EXISTS commission_payouts CASCADE;
