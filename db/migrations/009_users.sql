-- UP
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email varchar(255) NOT NULL,
  password_hash varchar(255) NOT NULL,
  name varchar(100) NOT NULL,
  phone varchar(50),
  status varchar(20) NOT NULL DEFAULT 'active',
  is_tenant_owner boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, email)
);

CREATE INDEX idx_users_tenant_id ON users (tenant_id);
CREATE INDEX idx_users_status ON users (status);
CREATE INDEX idx_users_deleted_at ON users (deleted_at);

-- DOWN
DROP TABLE IF EXISTS users CASCADE;
