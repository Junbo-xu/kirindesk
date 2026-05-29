-- UP
CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  code varchar(50) NOT NULL UNIQUE,
  name varchar(100) NOT NULL,
  description varchar(500),
  price_monthly decimal(10,2) NOT NULL DEFAULT 0,
  price_yearly decimal(10,2) NOT NULL DEFAULT 0,
  currency varchar(3) NOT NULL DEFAULT 'CNY',
  max_users integer NOT NULL DEFAULT 5,
  max_storage_gb integer NOT NULL DEFAULT 10,
  ai_quota_monthly integer NOT NULL DEFAULT 100,
  status varchar(20) NOT NULL DEFAULT 'active',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_plans_status ON plans (status);
CREATE INDEX idx_plans_sort_order ON plans (sort_order);

-- DOWN
DROP TABLE IF EXISTS plans CASCADE;
