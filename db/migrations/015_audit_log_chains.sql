-- UP
CREATE TABLE audit_log_chains (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  chain_key varchar(200) NOT NULL UNIQUE,
  tenant_id uuid REFERENCES tenants(id),
  last_log_id bigint,
  last_hash varchar(64) NOT NULL DEFAULT repeat('0', 64),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_chains_tenant_id ON audit_log_chains (tenant_id);

-- DOWN
DROP TABLE IF EXISTS audit_log_chains CASCADE;
