# RLS Test Plan

## Prerequisites

- PostgreSQL running via `docker compose up -d`
- Migrations applied via `pnpm db:migrate`
- Dev seed applied via `pnpm db:seed`

## Test Scenarios

### 1. No context set — returns empty

```sql
-- Connect as kirindesk user (has RLS enforced)
-- Do NOT set any app.current_* variables
SELECT count(*) FROM users;
-- Expected: 0 (RLS blocks all rows)
```

### 2. Correct tenant context — returns tenant data

```sql
BEGIN;
SELECT set_config('app.current_tenant_id', '00000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.current_user_id', '00000000-0000-0000-0000-000000000002', true);
SELECT set_config('app.current_actor_type', 'tenant_user', true);

SELECT count(*) FROM users;
-- Expected: 1 (dev user)
COMMIT;
```

### 3. Wrong tenant context — returns empty

```sql
BEGIN;
SELECT set_config('app.current_tenant_id', '00000000-0000-0000-0000-000000000099', true);
SELECT set_config('app.current_actor_type', 'tenant_user', true);

SELECT count(*) FROM users;
-- Expected: 0 (no data for this tenant)
COMMIT;
```

### 4. Cross-tenant INSERT blocked

```sql
BEGIN;
SELECT set_config('app.current_tenant_id', '00000000-0000-0000-0000-000000000099', true);
SELECT set_config('app.current_actor_type', 'tenant_user', true);

INSERT INTO users (tenant_id, email, password_hash, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'hack@evil.com', 'x', 'Hacker');
-- Expected: ERROR (WITH CHECK violation — tenant_id doesn't match context)
ROLLBACK;
```

### 5. audit_logs UPDATE forbidden

```sql
UPDATE audit_logs SET action = 'hacked' WHERE id = 1;
-- Expected: ERROR 'audit_logs table is append-only: UPDATE operations are forbidden'
```

### 6. audit_logs DELETE forbidden

```sql
DELETE FROM audit_logs WHERE id = 1;
-- Expected: ERROR 'audit_logs table is append-only: DELETE operations are forbidden'
```

### 7. audit_logs tenant_user insert — only own tenant

```sql
BEGIN;
SELECT set_config('app.current_tenant_id', '00000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.current_user_id', '00000000-0000-0000-0000-000000000002', true);
SELECT set_config('app.current_actor_type', 'tenant_user', true);

-- Should succeed
INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, resource_type, row_hash, prev_hash)
VALUES ('00000000-0000-0000-0000-000000000001', 'tenant_user', '00000000-0000-0000-0000-000000000002', 'test', 'test', repeat('a',64), repeat('0',64));

-- Should fail (wrong tenant_id)
INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, resource_type, row_hash, prev_hash)
VALUES ('00000000-0000-0000-0000-000000000099', 'tenant_user', '00000000-0000-0000-0000-000000000002', 'test', 'test', repeat('b',64), repeat('0',64));
ROLLBACK;
```

## Tables with RLS Enabled

- users
- roles
- user_roles
- role_permissions
- tenant_modules
- tenant_settings
- exchange_rates
- files
- file_access_tokens
- provider_invocations
- audit_logs
