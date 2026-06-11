-- UP
CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  company_name varchar(200) NOT NULL,
  contact_name varchar(100),
  email varchar(255),
  phone varchar(50),
  country varchar(100),
  category varchar(50),
  status varchar(20) NOT NULL DEFAULT 'active',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX idx_suppliers_tenant_id ON suppliers (tenant_id);
CREATE INDEX idx_suppliers_owner_user_id ON suppliers (owner_user_id);
CREATE INDEX idx_suppliers_status ON suppliers (status);
CREATE INDEX idx_suppliers_deleted_at ON suppliers (deleted_at);
CREATE INDEX idx_suppliers_tenant_owner ON suppliers (tenant_id, owner_user_id);
CREATE INDEX idx_suppliers_tenant_status ON suppliers (tenant_id, status);

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON suppliers
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON suppliers TO kirindesk_app;

-- DOWN
DROP TABLE IF EXISTS suppliers CASCADE;
