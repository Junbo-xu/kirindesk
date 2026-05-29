-- UP
CREATE TABLE provider_invocations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  provider_type varchar(30) NOT NULL,
  provider_name varchar(50) NOT NULL,
  action varchar(100) NOT NULL,
  request_json jsonb,
  response_json jsonb,
  status varchar(20) NOT NULL DEFAULT 'success',
  duration_ms integer,
  tokens_used integer,
  cost_estimate decimal(10,4),
  invoked_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_provider_invocations_tenant_type ON provider_invocations (tenant_id, provider_type);
CREATE INDEX idx_provider_invocations_created ON provider_invocations (created_at);
CREATE INDEX idx_provider_invocations_status ON provider_invocations (status);

-- DOWN
DROP TABLE IF EXISTS provider_invocations CASCADE;
