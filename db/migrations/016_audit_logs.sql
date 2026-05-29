-- UP
CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  tenant_id uuid,
  actor_type varchar(20) NOT NULL,
  actor_id uuid NOT NULL,
  action varchar(100) NOT NULL,
  resource_type varchar(100) NOT NULL,
  resource_id varchar(100),
  before_json jsonb,
  after_json jsonb,
  metadata_json jsonb,
  request_id varchar(50),
  ip_address varchar(45),
  user_agent varchar(500),
  reason varchar(500),
  row_hash varchar(64) NOT NULL,
  prev_hash varchar(64) NOT NULL,
  hash_version smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_tenant_created ON audit_logs (tenant_id, created_at);
CREATE INDEX idx_audit_logs_actor_id ON audit_logs (actor_id);
CREATE INDEX idx_audit_logs_resource ON audit_logs (resource_type, resource_id);
CREATE INDEX idx_audit_logs_request_id ON audit_logs (request_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs (created_at);

-- DOWN
DROP TABLE IF EXISTS audit_logs CASCADE;
