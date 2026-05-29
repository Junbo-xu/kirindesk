-- UP
CREATE TABLE tenant_settings (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key varchar(100) NOT NULL,
  value_json jsonb NOT NULL DEFAULT '{}',
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE INDEX idx_tenant_settings_tenant_id ON tenant_settings (tenant_id);

-- DOWN
DROP TABLE IF EXISTS tenant_settings CASCADE;
