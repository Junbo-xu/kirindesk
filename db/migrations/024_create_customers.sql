-- UP
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  company_name varchar(200) NOT NULL,
  contact_name varchar(100),
  email varchar(255),
  phone varchar(50),
  country varchar(100),
  source varchar(50),
  status varchar(20) NOT NULL DEFAULT 'active',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX idx_customers_tenant_id ON customers (tenant_id);
CREATE INDEX idx_customers_owner_user_id ON customers (owner_user_id);
CREATE INDEX idx_customers_status ON customers (status);
CREATE INDEX idx_customers_deleted_at ON customers (deleted_at);
CREATE INDEX idx_customers_tenant_owner ON customers (tenant_id, owner_user_id);
CREATE INDEX idx_customers_tenant_status ON customers (tenant_id, status);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON customers
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON customers TO kirindesk_app;

-- DOWN
DROP TABLE IF EXISTS customers CASCADE;
