-- Seed: System modules
INSERT INTO modules (id, code, name, description, sort_order) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'crm', '客户管理', 'Customer relationship management', 1),
  ('a0000000-0000-0000-0000-000000000002', 'orders', '订单管理', 'Order management', 2),
  ('a0000000-0000-0000-0000-000000000003', 'procurement', '采购管理', 'Procurement management', 3),
  ('a0000000-0000-0000-0000-000000000004', 'finance', '财务管理', 'Finance management', 4),
  ('a0000000-0000-0000-0000-000000000005', 'files', '文件管理', 'File management', 5),
  ('a0000000-0000-0000-0000-000000000006', 'reports', '报表', 'Reports and analytics', 6),
  ('a0000000-0000-0000-0000-000000000007', 'system', '系统管理', 'System administration', 7),
  ('a0000000-0000-0000-0000-000000000008', 'ai', 'AI/OCR', 'AI and OCR provider invocations', 8)
ON CONFLICT (code) DO NOTHING;
