-- UP
CREATE TABLE platform_admins (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  email varchar(255) NOT NULL UNIQUE,
  password_hash varchar(255) NOT NULL,
  name varchar(100) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active',
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_platform_admins_status ON platform_admins (status);

-- DOWN
DROP TABLE IF EXISTS platform_admins CASCADE;
