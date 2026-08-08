-- UP
INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
SELECT create_grant.tenant_id,
       create_grant.role_id,
       update_permission.id,
       CASE
         WHEN create_grant.data_scope = 'own' OR submit_grant.data_scope = 'own' THEN 'own'
         WHEN create_grant.data_scope = 'assigned' OR submit_grant.data_scope = 'assigned'
           THEN 'assigned'
         ELSE 'all'
       END
  FROM role_permissions create_grant
  JOIN permissions create_permission
    ON create_permission.id = create_grant.permission_id
  JOIN role_permissions submit_grant
    ON submit_grant.tenant_id = create_grant.tenant_id
   AND submit_grant.role_id = create_grant.role_id
  JOIN permissions submit_permission
    ON submit_permission.id = submit_grant.permission_id
 CROSS JOIN permissions update_permission
 WHERE create_permission.code = 'inquiries:create'
   AND submit_permission.code = 'inquiries:submit'
   AND update_permission.code = 'inquiries:update'
ON CONFLICT (tenant_id, role_id, permission_id) DO NOTHING;

-- DOWN
-- The backfill cannot distinguish grants it inserted from grants a tenant
-- administrator created independently. Preserve both classes on rollback.
SELECT 1;
