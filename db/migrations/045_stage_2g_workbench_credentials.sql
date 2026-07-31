-- UP
-- Stage 2G: persistent business exceptions and a minimal credential-chain
-- projection. The projection stores references and event types only; business
-- plaintext remains in its owning table and sensitive audit evidence remains
-- in the restricted audit chain.

CREATE TABLE business_exceptions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  context_type varchar(50) NOT NULL,
  context_id uuid NOT NULL,
  exception_type varchar(40) NOT NULL,
  severity varchar(16) NOT NULL DEFAULT 'medium',
  status varchar(20) NOT NULL DEFAULT 'open',
  summary varchar(240) NOT NULL,
  owner_user_id uuid,
  assigned_to_user_id uuid,
  resolution text,
  version integer NOT NULL DEFAULT 1,
  detected_at timestamptz NOT NULL DEFAULT now(),
  assigned_at timestamptz,
  started_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_business_exceptions_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT fk_business_exceptions_owner
    FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_business_exceptions_assignee
    FOREIGN KEY (tenant_id, assigned_to_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_business_exceptions_context_type CHECK (
    context_type IN (
      'customer', 'inquiry', 'sales_order', 'purchase_order',
      'shipment', 'finance_review', 'sample_order', 'after_sales_case'
    )
  ),
  CONSTRAINT chk_business_exceptions_type CHECK (
    exception_type IN ('price_variance', 'quantity_variance', 'missing_expense', 'duplicate_customer')
  ),
  CONSTRAINT chk_business_exceptions_severity CHECK (
    severity IN ('low', 'medium', 'high', 'critical')
  ),
  CONSTRAINT chk_business_exceptions_status CHECK (
    status IN ('open', 'assigned', 'in_progress', 'resolved', 'closed')
  ),
  CONSTRAINT chk_business_exceptions_version CHECK (version > 0),
  CONSTRAINT chk_business_exceptions_assignment CHECK (
    (status = 'open' AND assigned_to_user_id IS NULL AND assigned_at IS NULL)
    OR (status <> 'open' AND assigned_to_user_id IS NOT NULL AND assigned_at IS NOT NULL)
  ),
  CONSTRAINT chk_business_exceptions_resolution CHECK (
    (status IN ('open', 'assigned', 'in_progress') AND resolution IS NULL AND resolved_at IS NULL)
    OR (status IN ('resolved', 'closed') AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT chk_business_exceptions_closed CHECK (
    (status = 'closed' AND closed_at IS NOT NULL) OR (status <> 'closed' AND closed_at IS NULL)
  )
);

CREATE INDEX idx_business_exceptions_tenant_status
  ON business_exceptions (tenant_id, status, severity, detected_at DESC);
CREATE INDEX idx_business_exceptions_tenant_assignee
  ON business_exceptions (tenant_id, assigned_to_user_id, status);
CREATE INDEX idx_business_exceptions_tenant_owner
  ON business_exceptions (tenant_id, owner_user_id, status);
CREATE INDEX idx_business_exceptions_tenant_context
  ON business_exceptions (tenant_id, context_type, context_id, detected_at DESC);

CREATE TABLE business_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  chain_type varchar(50) NOT NULL,
  chain_id uuid NOT NULL,
  credential_type varchar(50) NOT NULL,
  credential_id uuid NOT NULL,
  event_type varchar(100) NOT NULL,
  actor_type varchar(20) NOT NULL,
  actor_id uuid,
  scope_user_id uuid,
  visibility_permission varchar(100) NOT NULL REFERENCES permissions(code) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_business_events_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT fk_business_events_scope_user
    FOREIGN KEY (tenant_id, scope_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_business_events_actor_type CHECK (
    actor_type IN ('tenant_user', 'platform_admin', 'system')
  )
);

CREATE INDEX idx_business_events_tenant_chain
  ON business_events (tenant_id, chain_type, chain_id, occurred_at DESC);
CREATE INDEX idx_business_events_tenant_credential
  ON business_events (tenant_id, credential_type, credential_id, occurred_at DESC);
CREATE INDEX idx_business_events_tenant_visibility
  ON business_events (tenant_id, visibility_permission, occurred_at DESC);

CREATE OR REPLACE FUNCTION prevent_business_event_modification()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'business_events is append-only: % is forbidden', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_modify_business_events
  BEFORE UPDATE OR DELETE ON business_events
  FOR EACH ROW EXECUTE FUNCTION prevent_business_event_modification();

ALTER TABLE business_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_exceptions FORCE ROW LEVEL SECURITY;
ALTER TABLE business_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON business_exceptions FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON business_events FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON business_exceptions TO kirindesk_app;
GRANT SELECT, INSERT ON business_events TO kirindesk_app;
REVOKE UPDATE, DELETE ON business_events FROM kirindesk_app;

-- DOWN
DROP TABLE IF EXISTS business_events CASCADE;
DROP FUNCTION IF EXISTS prevent_business_event_modification();
DROP TABLE IF EXISTS business_exceptions CASCADE;
