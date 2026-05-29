-- UP
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name varchar(200) NOT NULL,
  slug varchar(100) NOT NULL UNIQUE,
  status varchar(20) NOT NULL DEFAULT 'active',
  owner_user_id uuid DEFAULT NULL,
  contact_email varchar(255),
  contact_phone varchar(50),
  timezone varchar(50) DEFAULT 'Asia/Shanghai',
  locale varchar(10) DEFAULT 'zh-CN',
  metadata_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX idx_tenants_status ON tenants (status);
CREATE INDEX idx_tenants_deleted_at ON tenants (deleted_at);

-- DOWN
DROP TABLE IF EXISTS tenants CASCADE;
