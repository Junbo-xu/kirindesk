-- UP
INSERT INTO permissions (module_id, code, name, action)
SELECT id, 'inquiries:update', '编辑询盘草稿', 'update'
  FROM modules
 WHERE code = 'orders'
ON CONFLICT (code) DO NOTHING;

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

GRANT DELETE ON inquiry_items TO kirindesk_app;

-- DOWN
DELETE FROM role_permissions
 WHERE permission_id = (SELECT id FROM permissions WHERE code = 'inquiries:update');
DELETE FROM permissions WHERE code = 'inquiries:update';
REVOKE DELETE ON inquiry_items FROM kirindesk_app;
