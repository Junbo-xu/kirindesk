-- ============================================================
-- DEV ONLY — Local RLS testing fixture
-- NOT a login-capable account. Auth is not implemented.
-- password_hash is a placeholder, not a real bcrypt hash.
-- This seed MUST NOT run in production.
-- Controlled by: seed runner checks NODE_ENV !== 'production'
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

-- Dev user (NOT a real login account — Auth is not implemented)
INSERT INTO users (id, tenant_id, email, password_hash, name, status, is_tenant_owner)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'admin@dev.local',
  '$PLACEHOLDER_NOT_FOR_AUTH$',
  'Dev Admin',
  'active',
  true
) ON CONFLICT (tenant_id, email) DO NOTHING;

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
