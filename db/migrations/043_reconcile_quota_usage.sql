-- UP
INSERT INTO tenant_quota_usage (
  tenant_id,
  user_count,
  storage_bytes,
  ai_calls_month,
  ai_calls_reset_at,
  updated_at
)
SELECT
  t.id,
  (SELECT COUNT(*)::integer
     FROM users u
    WHERE u.tenant_id = t.id
      AND u.status = 'active'
      AND u.deleted_at IS NULL),
  COALESCE((SELECT SUM(f.size_bytes)
              FROM files f
             WHERE f.tenant_id = t.id
               AND f.deleted_at IS NULL), 0),
  (SELECT COUNT(*)::integer
     FROM provider_invocations p
    WHERE p.tenant_id = t.id
      AND p.status = 'success'
      AND p.created_at >= date_trunc('month', now())),
  date_trunc('month', now()),
  now()
FROM tenants t
ON CONFLICT (tenant_id) DO UPDATE
SET user_count = EXCLUDED.user_count,
    storage_bytes = EXCLUDED.storage_bytes,
    ai_calls_month = EXCLUDED.ai_calls_month,
    ai_calls_reset_at = EXCLUDED.ai_calls_reset_at,
    updated_at = now();

-- DOWN
-- The snapshot is derived from authoritative business rows. Rolling it back
-- would intentionally reintroduce stale values, so recovery is forward-only.
SELECT 1;
