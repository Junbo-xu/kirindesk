-- UP
-- Phase 1F-C: order approval workflow.
-- Introduces a shared approval-decision ledger (order_approvals) across both
-- order types and widens the order status enum to include the approval states.
-- See docs/phase-1f-c-approval-workflow-plan.md §4 / §9.
--
-- Design notes (per plan):
--   * Single shared table with an order_type discriminator ('sales'|'purchase')
--     + order_id. A column cannot REFERENCES two parent tables, so there is NO
--     hard FK to the order; referential integrity is guaranteed by the service
--     layer (rows only written inside the order's tenant-context transaction,
--     immediately after the order status UPDATE) plus tenant_id + RLS, and
--     orders are soft-deleted (never hard-deleted) so order_id never dangles.
--   * Immutable ledger: append-only, one row per transition. No updated_at and
--     no deleted_at; the app role is granted SELECT, INSERT only (no UPDATE /
--     DELETE) to enforce immutability at the privilege level.
--   * level (default 1) reserves multi-level approval for a future phase.

CREATE TABLE order_approvals (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_type varchar(16) NOT NULL,
  order_id uuid NOT NULL,
  level smallint NOT NULL DEFAULT 1,
  action varchar(20) NOT NULL,
  from_status varchar(32) NOT NULL,
  to_status varchar(32) NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_order_approvals_order_type CHECK (order_type IN ('sales','purchase')),
  CONSTRAINT chk_order_approvals_action CHECK (action IN ('submit','approve','reject','withdraw')),
  CONSTRAINT chk_order_approvals_level CHECK (level >= 1)
);

-- Workhorse index: "latest decision for this order (at the top level)" and the
-- full per-order history both read off this composite. tenant_id leads to align
-- with the RLS predicate.
CREATE INDEX idx_order_approvals_order
  ON order_approvals (tenant_id, order_type, order_id, level DESC, created_at DESC);

ALTER TABLE order_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON order_approvals
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Immutable ledger: app role may read and append, never mutate or remove.
-- The schema default privileges (000_app_role.sql) grant SELECT/INSERT/UPDATE/
-- DELETE to kirindesk_app on every new table, so simply granting SELECT,INSERT
-- is not enough — UPDATE and DELETE must be explicitly revoked to enforce
-- append-only at the privilege level.
GRANT SELECT, INSERT ON order_approvals TO kirindesk_app;
REVOKE UPDATE, DELETE ON order_approvals FROM kirindesk_app;

-- Widen the status CHECK on both order tables to the new superset. Drop + re-add
-- (mirrors how 031 added its FX constraints). Non-destructive: the new set is a
-- superset of the old four states, so existing rows stay valid and no backfill
-- is needed. DEFAULT 'draft' is unchanged.
ALTER TABLE sales_orders DROP CONSTRAINT chk_sales_orders_status;
ALTER TABLE sales_orders ADD CONSTRAINT chk_sales_orders_status
  CHECK (status IN ('draft','pending_approval','approved','rejected',
                    'confirmed','completed','cancelled'));

ALTER TABLE purchase_orders DROP CONSTRAINT chk_purchase_orders_status;
ALTER TABLE purchase_orders ADD CONSTRAINT chk_purchase_orders_status
  CHECK (status IN ('draft','pending_approval','approved','rejected',
                    'confirmed','completed','cancelled'));

-- DOWN
-- Reverse order. Restoring the narrow four-state CHECK would fail if any order
-- is currently in one of the new states, so first coerce stragglers to the
-- nearest valid old state (plan §9.2) — pending_approval / rejected revert to
-- draft (work-in-progress), approved advances to confirmed (the equivalent
-- "ready" state). This makes rollback deterministic rather than throwing on a
-- CHECK violation.
UPDATE sales_orders SET status = 'draft'
  WHERE status IN ('pending_approval','rejected');
UPDATE sales_orders SET status = 'confirmed'
  WHERE status = 'approved';
UPDATE purchase_orders SET status = 'draft'
  WHERE status IN ('pending_approval','rejected');
UPDATE purchase_orders SET status = 'confirmed'
  WHERE status = 'approved';

ALTER TABLE purchase_orders DROP CONSTRAINT chk_purchase_orders_status;
ALTER TABLE purchase_orders ADD CONSTRAINT chk_purchase_orders_status
  CHECK (status IN ('draft','confirmed','completed','cancelled'));

ALTER TABLE sales_orders DROP CONSTRAINT chk_sales_orders_status;
ALTER TABLE sales_orders ADD CONSTRAINT chk_sales_orders_status
  CHECK (status IN ('draft','confirmed','completed','cancelled'));

DROP TABLE IF EXISTS order_approvals CASCADE;
