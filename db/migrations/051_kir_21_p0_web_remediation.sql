-- UP
INSERT INTO permissions (module_id, code, name, action)
SELECT id, 'inquiries:update', '编辑询盘草稿', 'update'
  FROM modules
 WHERE code = 'orders'
ON CONFLICT (code) DO NOTHING;

GRANT DELETE ON inquiry_items TO kirindesk_app;

-- DOWN
DELETE FROM role_permissions
 WHERE permission_id = (SELECT id FROM permissions WHERE code = 'inquiries:update');
DELETE FROM permissions WHERE code = 'inquiries:update';
REVOKE DELETE ON inquiry_items FROM kirindesk_app;
