-- UP
-- Phase 1F-E: commission calculation.
-- Introduces the commission rate model (mutable until locked) and the immutable
-- settlement snapshot (append-only). See docs/phase-1f-e-commission-plan.md §4 / §9.
--
-- Design notes (per plan):
--   * Two mutable rate-model tables (commission_tables + commission_rate_rules)
--     and two immutable append-only settlement tables (commission_settlements +
--     commission_settlement_lines). Created in FK dependency order: parents
--     before children.
--   * Rate is numeric(7,4) percent (5.0000 = 5%); money is numeric(18,2) in the
--     tenant base currency, matching 1F-B/1F-D.
--   * No hard FK from settlements to orders (like order_approvals): realized
--     order ids live inside the snapshot jsonb for traceability; integrity comes
--     from RLS + soft-deleted (never hard-deleted) orders. Rate rules reference
--     users(id) (the salesperson = order owner_user_id), not orders.
--   * Settlement tables are immutable at the privilege level: granted
--     SELECT, INSERT only, with UPDATE/DELETE revoked (the 000_app_role.sql
--     default grants all four on every new table, so the REVOKE is required).
--   * Unlock is modeled as a superseding append (a new row whose `supersedes`
--     back-points at the row it replaces), never an in-place mutation. There is
--     intentionally NO plain UNIQUE on (tenant, table, period) — superseding
--     rows repeat that tuple — so single-currentness is enforced at the service
--     layer under a SELECT ... FOR UPDATE row lock (plan §3 D3 / §4.2).

-- 1. commission_tables — the rate model (mutable until locked)
CREATE TABLE commission_tables (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  name         varchar(128) NOT NULL,
  default_rate numeric(7, 4) NOT NULL DEFAULT 0,
  status       varchar(16) NOT NULL DEFAULT 'active',
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_commission_tables_default_rate CHECK (default_rate >= 0),
  CONSTRAINT chk_commission_tables_status CHECK (status IN ('active', 'archived'))
);

-- 2. commission_rate_rules — per-salesperson rate overrides (mutable)
CREATE TABLE commission_rate_rules (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  commission_table_id uuid NOT NULL REFERENCES commission_tables(id) ON DELETE CASCADE,
  salesperson_user_id uuid NOT NULL REFERENCES users(id),
  rate                numeric(7, 4) NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_commission_rate_rules UNIQUE (tenant_id, commission_table_id, salesperson_user_id),
  CONSTRAINT chk_commission_rate_rules_rate CHECK (rate >= 0)
);

-- 3. commission_settlements — the immutable lock snapshot header (append-only)
CREATE TABLE commission_settlements (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  commission_table_id   uuid NOT NULL REFERENCES commission_tables(id),
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  caliber               varchar(16) NOT NULL DEFAULT 'realized',
  status                varchar(16) NOT NULL DEFAULT 'locked',
  -- frozen inputs for explainability (plan §3 D5): rate set + realized order ids
  -- + their base amounts that produced the figures, captured at lock time.
  snapshot              jsonb NOT NULL,
  total_commission_base numeric(18, 2) NOT NULL,
  total_basis_base      numeric(18, 2) NOT NULL,
  uncosted_count        integer NOT NULL DEFAULT 0,
  locked_by             uuid NOT NULL REFERENCES users(id),
  locked_at             timestamptz NOT NULL DEFAULT now(),
  unlocked_by           uuid REFERENCES users(id),
  unlocked_at           timestamptz,
  -- a superseding row points back at the row it replaces; NULL on an original lock.
  supersedes            uuid REFERENCES commission_settlements(id),
  CONSTRAINT chk_commission_settlements_period CHECK (period_end >= period_start),
  CONSTRAINT chk_commission_settlements_status CHECK (status IN ('locked', 'unlocked')),
  CONSTRAINT chk_commission_settlements_caliber CHECK (caliber IN ('realized', 'approved_up', 'pipeline', 'all')),
  CONSTRAINT chk_commission_settlements_totals CHECK (total_commission_base >= 0 AND total_basis_base >= 0)
);

-- 4. commission_settlement_lines — frozen per-salesperson figures (append-only)
CREATE TABLE commission_settlement_lines (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  settlement_id       uuid NOT NULL REFERENCES commission_settlements(id) ON DELETE CASCADE,
  salesperson_user_id uuid NOT NULL REFERENCES users(id),
  basis_base          numeric(18, 2) NOT NULL,
  rate_applied        numeric(7, 4) NOT NULL,
  commission_base     numeric(18, 2) NOT NULL,
  order_count         integer NOT NULL DEFAULT 0,
  uncosted_count      integer NOT NULL DEFAULT 0,
  CONSTRAINT uq_commission_settlement_lines UNIQUE (tenant_id, settlement_id, salesperson_user_id),
  CONSTRAINT chk_commission_settlement_lines_amounts
    CHECK (basis_base >= 0 AND rate_applied >= 0 AND commission_base >= 0)
);

-- Indexes (tenant_id leads to align with the RLS predicate).
CREATE INDEX idx_commission_tables_tenant
  ON commission_tables (tenant_id);
CREATE INDEX idx_commission_rate_rules_tenant
  ON commission_rate_rules (tenant_id, commission_table_id);
CREATE INDEX idx_commission_rate_rules_person
  ON commission_rate_rules (tenant_id, salesperson_user_id);
CREATE INDEX idx_commission_settlements_tenant
  ON commission_settlements (tenant_id, commission_table_id, period_start, period_end);
CREATE INDEX idx_commission_settlement_lines_settlement
  ON commission_settlement_lines (tenant_id, settlement_id);
CREATE INDEX idx_commission_settlement_lines_person
  ON commission_settlement_lines (tenant_id, salesperson_user_id);

-- RLS: tenant isolation on all four tables.
ALTER TABLE commission_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_tables FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON commission_tables
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE commission_rate_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_rate_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON commission_rate_rules
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE commission_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON commission_settlements
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE commission_settlement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_settlement_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON commission_settlement_lines
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Grants. The mutable rate-model pair keeps the default full DML. The immutable
-- settlement pair is append-only: grant SELECT, INSERT then explicitly REVOKE
-- UPDATE, DELETE (the 000_app_role.sql default grants all four on every new
-- table, so the REVOKE is what enforces immutability at the privilege level).
GRANT SELECT, INSERT, UPDATE, DELETE ON commission_tables, commission_rate_rules TO kirindesk_app;
GRANT SELECT, INSERT ON commission_settlements, commission_settlement_lines TO kirindesk_app;
REVOKE UPDATE, DELETE ON commission_settlements, commission_settlement_lines FROM kirindesk_app;

-- DOWN
-- Reverse dependency order: children before parents. Purely additive migration
-- (no altered columns, no coerced data), so the down is a clean drop. CASCADE
-- clears the RLS policies and FKs with their tables.
DROP TABLE IF EXISTS commission_settlement_lines CASCADE;
DROP TABLE IF EXISTS commission_settlements CASCADE;
DROP TABLE IF EXISTS commission_rate_rules CASCADE;
DROP TABLE IF EXISTS commission_tables CASCADE;
