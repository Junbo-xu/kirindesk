-- UP
CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  uploaded_by uuid NOT NULL,
  original_name varchar(500) NOT NULL,
  storage_key varchar(500) NOT NULL UNIQUE,
  mime_type varchar(100) NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 varchar(64) NOT NULL,
  purpose varchar(50),
  metadata_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX idx_files_tenant_id ON files (tenant_id);
CREATE INDEX idx_files_uploaded_by ON files (uploaded_by);
CREATE INDEX idx_files_purpose ON files (purpose);
CREATE INDEX idx_files_sha256 ON files (sha256);

-- DOWN
DROP TABLE IF EXISTS files CASCADE;
