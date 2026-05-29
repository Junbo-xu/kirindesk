-- Seed: Subscription plans
INSERT INTO plans (id, code, name, description, price_monthly, price_yearly, currency, max_users, max_storage_gb, ai_quota_monthly, status, sort_order) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'free', '免费版', '基础功能，适合小团队试用', 0, 0, 'CNY', 3, 5, 50, 'active', 1),
  ('b0000000-0000-0000-0000-000000000002', 'standard', '标准版', '全模块，标准配额', 299, 2990, 'CNY', 10, 50, 500, 'active', 2),
  ('b0000000-0000-0000-0000-000000000003', 'professional', '专业版', '全模块，高配额，优先支持', 599, 5990, 'CNY', 50, 200, 2000, 'active', 3)
ON CONFLICT (code) DO NOTHING;
