-- UP
CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  order_number varchar(64) NOT NULL,
  pi_number varchar(64),
  pi_file_id uuid REFERENCES files(id) ON DELETE RESTRICT,
  currency varchar(3) NOT NULL,
  total_amount numeric(18,2) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'draft',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT uq_purchase_orders_tenant_order_number UNIQUE (tenant_id, order_number),
  CONSTRAINT chk_purchase_orders_currency CHECK (currency IN ('RMB','USD','HKD','EUR')),
  CONSTRAINT chk_purchase_orders_status CHECK (status IN ('draft','confirmed','completed','cancelled')),
  CONSTRAINT chk_purchase_orders_total_amount CHECK (total_amount >= 0)
);

CREATE INDEX idx_purchase_orders_tenant_id ON purchase_orders (tenant_id);
CREATE INDEX idx_purchase_orders_tenant_supplier ON purchase_orders (tenant_id, supplier_id);
CREATE INDEX idx_purchase_orders_tenant_owner ON purchase_orders (tenant_id, owner_user_id);
CREATE INDEX idx_purchase_orders_tenant_status ON purchase_orders (tenant_id, status);
CREATE INDEX idx_purchase_orders_tenant_created_at ON purchase_orders (tenant_id, created_at);
CREATE INDEX idx_purchase_orders_deleted_at ON purchase_orders (deleted_at);

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON purchase_orders
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_orders TO kirindesk_app;

-- DOWN
DROP TABLE IF EXISTS purchase_orders CASCADE;
