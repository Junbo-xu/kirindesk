-- UP

-- users
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON users
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- roles
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON roles
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- user_roles
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON user_roles
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- role_permissions
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON role_permissions
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- tenant_modules
ALTER TABLE tenant_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_modules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON tenant_modules
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- tenant_settings
ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON tenant_settings
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- exchange_rates
ALTER TABLE exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON exchange_rates
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- files
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON files
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- file_access_tokens
ALTER TABLE file_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_access_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON file_access_tokens
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- provider_invocations
ALTER TABLE provider_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_invocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON provider_invocations
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- audit_logs (special: tenant read + actor-based insert)
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_logs_tenant_read ON audit_logs
  FOR SELECT
  USING (
    tenant_id = app_current_tenant_id()
    OR (tenant_id IS NULL AND app_current_actor_type() = 'platform_admin')
  );

CREATE POLICY audit_logs_tenant_insert ON audit_logs
  FOR INSERT
  WITH CHECK (
    app_current_actor_type() = 'tenant_user'
    AND tenant_id IS NOT NULL
    AND tenant_id = app_current_tenant_id()
  );

CREATE POLICY audit_logs_platform_insert ON audit_logs
  FOR INSERT
  WITH CHECK (
    app_current_actor_type() = 'platform_admin'
    AND tenant_id IS NULL
  );

CREATE POLICY audit_logs_system_insert ON audit_logs
  FOR INSERT
  WITH CHECK (
    app_current_actor_type() = 'system'
  );

-- DOWN
DROP POLICY IF EXISTS tenant_isolation_policy ON users;
ALTER TABLE users DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON roles;
ALTER TABLE roles DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON user_roles;
ALTER TABLE user_roles DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON role_permissions;
ALTER TABLE role_permissions DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_modules;
ALTER TABLE tenant_modules DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_settings;
ALTER TABLE tenant_settings DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON exchange_rates;
ALTER TABLE exchange_rates DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON files;
ALTER TABLE files DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON file_access_tokens;
ALTER TABLE file_access_tokens DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON provider_invocations;
ALTER TABLE provider_invocations DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_logs_tenant_read ON audit_logs;
DROP POLICY IF EXISTS audit_logs_tenant_insert ON audit_logs;
DROP POLICY IF EXISTS audit_logs_platform_insert ON audit_logs;
DROP POLICY IF EXISTS audit_logs_system_insert ON audit_logs;
ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
