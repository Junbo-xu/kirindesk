-- UP
-- Phase 2A: billing & payment (mock provider only — no real gateway, §7).
-- See docs/phase-2a-billing-payment-plan.md.
--
-- Design notes (per plan):
--   * billing_invoices: one charge per tenant per billing period, amount frozen
--     in integer cents (amount_cents bigint) copied from the plan price at issue
--     time. Status machine pending -> paid | void. FORCE RLS tenant_isolation.
--     Append-only money: GRANT SELECT/INSERT/UPDATE (UPDATE for the status
--     machine), REVOKE DELETE; a BEFORE UPDATE trigger freezes amount_cents.
--   * billing_payments: immutable record of a provider charge attempt against an
--     invoice. SELECT/INSERT only (UPDATE/DELETE revoked) — a payment row is
--     written once and never changed. At most one succeeded payment per invoice
--     (partial unique index) — the DB-level no-double-pay guard.
--   * Money is integer cents (bigint), mirroring the commission BigInt-cents
--     convention; currency is copied from the plan. No FX here.

-- 1. billing_invoices — the per-period charge header
CREATE TABLE billing_invoices (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  plan_id        uuid NOT NULL REFERENCES plans(id),
  billing_period varchar(16) NOT NULL,
  amount_cents   bigint NOT NULL,
  currency       varchar(8) NOT NULL,
  status         varchar(16) NOT NULL DEFAULT 'pending',
  issued_at      timestamptz NOT NULL DEFAULT now(),
  due_at         timestamptz,
  paid_at        timestamptz,
  void_reason    varchar(500),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_billing_invoices_period
    CHECK (billing_period IN ('monthly', 'yearly')),
  CONSTRAINT chk_billing_invoices_status
    CHECK (status IN ('pending', 'paid', 'void')),
  CONSTRAINT chk_billing_invoices_amount CHECK (amount_cents >= 0),
  -- paid must carry a timestamp; void must carry a reason.
  CONSTRAINT chk_billing_invoices_paid
    CHECK (status <> 'paid' OR paid_at IS NOT NULL),
  CONSTRAINT chk_billing_invoices_void
    CHECK (status <> 'void' OR void_reason IS NOT NULL)
);

-- 2. billing_payments — immutable provider charge record (one+ per invoice)
CREATE TABLE billing_payments (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  invoice_id   uuid NOT NULL REFERENCES billing_invoices(id),
  provider     varchar(32) NOT NULL,
  provider_ref varchar(128),
  amount_cents bigint NOT NULL,
  currency     varchar(8) NOT NULL,
  status       varchar(16) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_billing_payments_status
    CHECK (status IN ('succeeded', 'failed')),
  CONSTRAINT chk_billing_payments_amount CHECK (amount_cents >= 0)
);

-- Indexes (tenant_id leads to align with the RLS predicate).
CREATE INDEX idx_billing_invoices_tenant_status
  ON billing_invoices (tenant_id, status);
CREATE INDEX idx_billing_invoices_tenant_issued
  ON billing_invoices (tenant_id, issued_at);
CREATE INDEX idx_billing_payments_tenant_invoice
  ON billing_payments (tenant_id, invoice_id);

-- No-double-pay: at most one succeeded payment per invoice. RLS still isolates
-- by tenant; invoice_id is a PK so the scope is globally unique.
CREATE UNIQUE INDEX uq_billing_payments_succeeded_invoice
  ON billing_payments (invoice_id)
  WHERE status = 'succeeded';

-- RLS: tenant isolation on both tables (same policy as every tenant table).
ALTER TABLE billing_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON billing_invoices
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE billing_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON billing_payments
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Grants. Invoices keep UPDATE for the pending->paid|void status machine; DELETE
-- revoked. Payments are write-once: SELECT/INSERT only, UPDATE+DELETE revoked.
-- (000_app_role.sql default-grants all four on every new table, so the ones we
-- do not want are explicitly revoked here.)
GRANT SELECT, INSERT, UPDATE ON billing_invoices TO kirindesk_app;
REVOKE DELETE ON billing_invoices FROM kirindesk_app;
GRANT SELECT, INSERT ON billing_payments TO kirindesk_app;
REVOKE UPDATE, DELETE ON billing_payments FROM kirindesk_app;

-- Freeze-money-column trigger on invoices. UPDATE is granted for the status
-- machine, so this trigger is what makes amount_cents write-once at the DB level
-- (mirrors the commission_payouts freeze trigger).
CREATE OR REPLACE FUNCTION prevent_billing_invoice_amount_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.amount_cents IS DISTINCT FROM OLD.amount_cents THEN
    RAISE EXCEPTION 'billing_invoices.amount_cents is immutable after creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER freeze_billing_invoice_amount
  BEFORE UPDATE ON billing_invoices
  FOR EACH ROW EXECUTE FUNCTION prevent_billing_invoice_amount_change();

-- DOWN
-- Reverse dependency order: trigger/function, then child before parent. Purely
-- additive migration (no altered columns, no coerced data), so the down is a
-- clean drop. CASCADE clears the RLS policies, indexes, and FKs with the tables.
DROP TRIGGER IF EXISTS freeze_billing_invoice_amount ON billing_invoices;
DROP FUNCTION IF EXISTS prevent_billing_invoice_amount_change();
DROP TABLE IF EXISTS billing_payments CASCADE;
DROP TABLE IF EXISTS billing_invoices CASCADE;
