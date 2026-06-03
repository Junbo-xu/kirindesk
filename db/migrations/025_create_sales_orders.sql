-- UP
CREATE TABLE sales_orders (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
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
  CONSTRAINT uq_sales_orders_tenant_order_number UNIQUE (tenant_id, order_number),
  CONSTRAINT chk_sales_orders_currency CHECK (currency IN ('RMB','USD','HKD','EUR')),
  CONSTRAINT chk_sales_orders_status CHECK (status IN ('draft','confirmed','completed','cancelled')),
  CONSTRAINT chk_sales_orders_total_amount CHECK (total_amount >= 0)
);

CREATE INDEX idx_sales_orders_tenant_id ON sales_orders (tenant_id);
CREATE INDEX idx_sales_orders_tenant_customer ON sales_orders (tenant_id, customer_id);
CREATE INDEX idx_sales_orders_tenant_owner ON sales_orders (tenant_id, owner_user_id);
CREATE INDEX idx_sales_orders_tenant_status ON sales_orders (tenant_id, status);
CREATE INDEX idx_sales_orders_tenant_created_at ON sales_orders (tenant_id, created_at);
CREATE INDEX idx_sales_orders_deleted_at ON sales_orders (deleted_at);

ALTER TABLE sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON sales_orders
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON sales_orders TO kirindesk_app;

-- DOWN
DROP TABLE IF EXISTS sales_orders CASCADE;
