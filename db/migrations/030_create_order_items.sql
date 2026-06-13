-- UP
-- Phase 1F-A: order line items for sales and purchase orders.
-- Two structurally identical tables; each row carries a redundant tenant_id so
-- RLS evaluates with no join to the order header (matches every other business
-- table). total_amount on the header is derived from these rows server-side.

CREATE TABLE sales_order_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  line_no integer NOT NULL,
  description varchar(500) NOT NULL,
  product_code varchar(64),
  unit varchar(16),
  quantity numeric(18,3) NOT NULL,
  unit_price numeric(18,4) NOT NULL,
  line_total numeric(18,2) NOT NULL,
  notes varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT chk_sales_order_items_line_no CHECK (line_no > 0),
  CONSTRAINT chk_sales_order_items_quantity CHECK (quantity > 0),
  CONSTRAINT chk_sales_order_items_unit_price CHECK (unit_price >= 0),
  CONSTRAINT chk_sales_order_items_line_total CHECK (line_total >= 0)
);

CREATE INDEX idx_sales_order_items_tenant_id ON sales_order_items (tenant_id);
CREATE INDEX idx_sales_order_items_tenant_order ON sales_order_items (tenant_id, order_id);
CREATE UNIQUE INDEX uq_sales_order_items_order_line_no
  ON sales_order_items (tenant_id, order_id, line_no)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_sales_order_items_deleted_at ON sales_order_items (deleted_at);

ALTER TABLE sales_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON sales_order_items
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON sales_order_items TO kirindesk_app;

CREATE TABLE purchase_order_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_no integer NOT NULL,
  description varchar(500) NOT NULL,
  product_code varchar(64),
  unit varchar(16),
  quantity numeric(18,3) NOT NULL,
  unit_price numeric(18,4) NOT NULL,
  line_total numeric(18,2) NOT NULL,
  notes varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT chk_purchase_order_items_line_no CHECK (line_no > 0),
  CONSTRAINT chk_purchase_order_items_quantity CHECK (quantity > 0),
  CONSTRAINT chk_purchase_order_items_unit_price CHECK (unit_price >= 0),
  CONSTRAINT chk_purchase_order_items_line_total CHECK (line_total >= 0)
);

CREATE INDEX idx_purchase_order_items_tenant_id ON purchase_order_items (tenant_id);
CREATE INDEX idx_purchase_order_items_tenant_order ON purchase_order_items (tenant_id, order_id);
CREATE UNIQUE INDEX uq_purchase_order_items_order_line_no
  ON purchase_order_items (tenant_id, order_id, line_no)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_purchase_order_items_deleted_at ON purchase_order_items (deleted_at);

ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON purchase_order_items
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_order_items TO kirindesk_app;

-- DOWN
DROP TABLE IF EXISTS purchase_order_items CASCADE;
DROP TABLE IF EXISTS sales_order_items CASCADE;
