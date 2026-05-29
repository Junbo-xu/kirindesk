-- UP
CREATE TABLE role_permissions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  role_id uuid NOT NULL REFERENCES roles(id),
  permission_id uuid NOT NULL REFERENCES permissions(id),
  data_scope varchar(20) NOT NULL DEFAULT 'all',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, role_id, permission_id)
);

CREATE INDEX idx_role_permissions_role_id ON role_permissions (role_id);
CREATE INDEX idx_role_permissions_permission_id ON role_permissions (permission_id);

-- DOWN
DROP TABLE IF EXISTS role_permissions CASCADE;
