-- ============================================================
-- DEV ONLY — Local development Auth & RLS testing fixtures
-- NOT production accounts. Auth is for development testing only.
-- Production platform admins MUST be created via CLI command.
-- This seed MUST NOT run in production (NODE_ENV check).
--
-- Dev credentials (local development only):
--   tenant user:    admin@dev.local / dev-password-123
--   platform admin: platform@dev.local / dev-password-123
-- ============================================================

-- Dev tenant
INSERT INTO tenants (id, name, slug, status, contact_email, timezone, locale)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Dev Tenant',
  'dev-tenant',
  'active',
  'dev@localhost',
  'Asia/Shanghai',
  'zh-CN'
) ON CONFLICT (slug) DO NOTHING;

-- Dev tenant user — password: dev-password-123
INSERT INTO users (id, tenant_id, email, password_hash, name, status, is_tenant_owner)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'admin@dev.local',
  '$2b$12$HofQVzPHAL5ujjH38jyNSeOT07ho.lr.PB7JItO8zh6WZ.QQNDLAW',
  'Dev Admin',
  'active',
  true
) ON CONFLICT (tenant_id, email) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  status = EXCLUDED.status,
  updated_at = now();

-- Dev platform admin — password: dev-password-123
INSERT INTO platform_admins (id, email, password_hash, name, status)
VALUES (
  '00000000-0000-0000-0000-000000000010',
  'platform@dev.local',
  '$2b$12$HofQVzPHAL5ujjH38jyNSeOT07ho.lr.PB7JItO8zh6WZ.QQNDLAW',
  'Dev Platform Admin',
  'active'
) ON CONFLICT (email) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  status = EXCLUDED.status,
  updated_at = now();

-- Audit log chain for dev tenant
INSERT INTO audit_log_chains (id, chain_key, tenant_id, last_hash)
VALUES (
  '00000000-0000-0000-0000-000000000003',
  'tenant:00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  repeat('0', 64)
) ON CONFLICT (chain_key) DO NOTHING;

-- Platform audit log chain
INSERT INTO audit_log_chains (id, chain_key, tenant_id, last_hash)
VALUES (
  '00000000-0000-0000-0000-000000000004',
  'platform',
  NULL,
  repeat('0', 64)
) ON CONFLICT (chain_key) DO NOTHING;

-- Dev RBAC: grant admin@dev.local an all-access role so local QA can hit
-- permission-protected endpoints. is_tenant_owner is NOT consulted by the
-- PermissionGuard, so the dev user needs explicit role/permission grants.
INSERT INTO roles (id, tenant_id, name, description, is_system)
VALUES (
  '00000000-0000-0000-0000-000000000020',
  '00000000-0000-0000-0000-000000000001',
  'Dev Admin',
  'Dev all-access role (development only)',
  true
) ON CONFLICT (tenant_id, name) DO NOTHING;

-- Bind every permission to the Dev Admin role with data_scope 'all'.
-- permission_id is resolved by subquery because permission ids are random uuids.
INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
SELECT
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000020',
  p.id,
  'all'
FROM permissions p
ON CONFLICT (tenant_id, role_id, permission_id) DO NOTHING;

-- Assign the Dev Admin role to admin@dev.local (user ...0002).
INSERT INTO user_roles (tenant_id, user_id, role_id)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000020'
) ON CONFLICT (tenant_id, user_id, role_id) DO NOTHING;
