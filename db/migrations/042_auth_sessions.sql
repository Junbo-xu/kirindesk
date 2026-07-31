-- UP
CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  actor_type varchar(30) NOT NULL CHECK (actor_type IN ('tenant_user', 'platform_admin')),
  actor_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  ip_address inet,
  user_agent text,
  CHECK (
    (actor_type = 'tenant_user' AND tenant_id IS NOT NULL)
    OR (actor_type = 'platform_admin' AND tenant_id IS NULL)
  )
);

CREATE INDEX idx_auth_sessions_tenant_actor
  ON auth_sessions (tenant_id, actor_id, expires_at DESC)
  WHERE actor_type = 'tenant_user';
CREATE INDEX idx_auth_sessions_platform_actor
  ON auth_sessions (actor_id, expires_at DESC)
  WHERE actor_type = 'platform_admin';
CREATE INDEX idx_auth_sessions_active
  ON auth_sessions (expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY auth_sessions_tenant_policy ON auth_sessions
  FOR ALL
  USING (
    actor_type = 'tenant_user'
    AND tenant_id = app_current_tenant_id()
  )
  WITH CHECK (
    actor_type = 'tenant_user'
    AND tenant_id = app_current_tenant_id()
  );

CREATE POLICY auth_sessions_platform_policy ON auth_sessions
  FOR ALL
  USING (
    actor_type = 'platform_admin'
    AND tenant_id IS NULL
    AND app_current_actor_type() = 'platform_admin'
  )
  WITH CHECK (
    actor_type = 'platform_admin'
    AND tenant_id IS NULL
    AND app_current_actor_type() = 'platform_admin'
  );

GRANT SELECT, INSERT, UPDATE ON auth_sessions TO kirindesk_app;
REVOKE DELETE ON auth_sessions FROM kirindesk_app;

-- DOWN
DROP TABLE IF EXISTS auth_sessions;
