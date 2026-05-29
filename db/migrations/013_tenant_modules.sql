-- UP
CREATE TABLE tenant_modules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  module_id uuid NOT NULL REFERENCES modules(id),
  enabled boolean NOT NULL DEFAULT true,
  enabled_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, module_id)
);

CREATE INDEX idx_tenant_modules_tenant_id ON tenant_modules (tenant_id);
CREATE INDEX idx_tenant_modules_module_id ON tenant_modules (module_id);

-- DOWN
DROP TABLE IF EXISTS tenant_modules CASCADE;
