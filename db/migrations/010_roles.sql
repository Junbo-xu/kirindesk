-- UP
CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name varchar(100) NOT NULL,
  description varchar(500),
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX idx_roles_tenant_id ON roles (tenant_id);

-- DOWN
DROP TABLE IF EXISTS roles CASCADE;
