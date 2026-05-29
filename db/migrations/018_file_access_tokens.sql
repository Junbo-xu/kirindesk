-- UP
CREATE TABLE file_access_tokens (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  file_id uuid NOT NULL REFERENCES files(id),
  token_hash varchar(64) NOT NULL UNIQUE,
  purpose varchar(50) NOT NULL DEFAULT 'download',
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_file_access_tokens_file_id ON file_access_tokens (file_id);
CREATE INDEX idx_file_access_tokens_expires ON file_access_tokens (expires_at);

-- DOWN
DROP TABLE IF EXISTS file_access_tokens CASCADE;
