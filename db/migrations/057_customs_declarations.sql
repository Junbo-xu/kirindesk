-- UP
CREATE TABLE customs_declaration_sets (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sales_order_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'draft',
  draft_revision integer NOT NULL DEFAULT 1,
  latest_version integer NOT NULL DEFAULT 0,
  source_order_snapshot jsonb NOT NULL,
  source_ci_export_id uuid NOT NULL,
  source_ci_snapshot jsonb NOT NULL,
  source_pl_export_id uuid NOT NULL,
  source_pl_snapshot jsonb NOT NULL,
  customs_data jsonb NOT NULL,
  source_fingerprint varchar(64) NOT NULL,
  created_by uuid NOT NULL,
  refreshed_by uuid,
  refreshed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_customs_declaration_sets_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_customs_declaration_sets_order UNIQUE (tenant_id, sales_order_id),
  CONSTRAINT fk_customs_declaration_sets_order
    FOREIGN KEY (tenant_id, sales_order_id)
    REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customs_declaration_sets_owner
    FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customs_declaration_sets_ci_export
    FOREIGN KEY (tenant_id, source_ci_export_id)
    REFERENCES trade_document_exports(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customs_declaration_sets_pl_export
    FOREIGN KEY (tenant_id, source_pl_export_id)
    REFERENCES trade_document_exports(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customs_declaration_sets_creator
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customs_declaration_sets_refresher
    FOREIGN KEY (tenant_id, refreshed_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_customs_declaration_sets_status CHECK (status IN ('draft', 'generated')),
  CONSTRAINT chk_customs_declaration_sets_revision CHECK (draft_revision > 0),
  CONSTRAINT chk_customs_declaration_sets_version CHECK (latest_version >= 0),
  CONSTRAINT chk_customs_declaration_sets_snapshots CHECK (
    jsonb_typeof(source_order_snapshot) = 'object'
    AND jsonb_typeof(source_ci_snapshot) = 'object'
    AND jsonb_typeof(source_pl_snapshot) = 'object'
    AND jsonb_typeof(customs_data) = 'object'
  ),
  CONSTRAINT chk_customs_declaration_sets_fingerprint
    CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_customs_declaration_sets_refresh CHECK (
    (refreshed_by IS NULL AND refreshed_at IS NULL)
    OR (refreshed_by IS NOT NULL AND refreshed_at IS NOT NULL)
  )
);

CREATE INDEX idx_customs_declaration_sets_tenant_owner
  ON customs_declaration_sets (tenant_id, owner_user_id, updated_at DESC);

CREATE TABLE customs_declaration_versions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  declaration_set_id uuid NOT NULL,
  version integer NOT NULL,
  source_order_snapshot jsonb NOT NULL,
  source_ci_export_id uuid NOT NULL,
  source_ci_snapshot jsonb NOT NULL,
  source_pl_export_id uuid NOT NULL,
  source_pl_snapshot jsonb NOT NULL,
  customs_data jsonb NOT NULL,
  consistency_result jsonb NOT NULL,
  source_fingerprint varchar(64) NOT NULL,
  pre_entry_file_id uuid NOT NULL,
  authorization_file_id uuid NOT NULL,
  generated_by uuid NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_customs_declaration_versions_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_customs_declaration_versions_number
    UNIQUE (tenant_id, declaration_set_id, version),
  CONSTRAINT fk_customs_declaration_versions_set
    FOREIGN KEY (tenant_id, declaration_set_id)
    REFERENCES customs_declaration_sets(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customs_declaration_versions_ci_export
    FOREIGN KEY (tenant_id, source_ci_export_id)
    REFERENCES trade_document_exports(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customs_declaration_versions_pl_export
    FOREIGN KEY (tenant_id, source_pl_export_id)
    REFERENCES trade_document_exports(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customs_declaration_versions_pre_entry_file
    FOREIGN KEY (tenant_id, pre_entry_file_id) REFERENCES files(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customs_declaration_versions_authorization_file
    FOREIGN KEY (tenant_id, authorization_file_id)
    REFERENCES files(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customs_declaration_versions_generator
    FOREIGN KEY (tenant_id, generated_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_customs_declaration_versions_number CHECK (version > 0),
  CONSTRAINT chk_customs_declaration_versions_snapshots CHECK (
    jsonb_typeof(source_order_snapshot) = 'object'
    AND jsonb_typeof(source_ci_snapshot) = 'object'
    AND jsonb_typeof(source_pl_snapshot) = 'object'
    AND jsonb_typeof(customs_data) = 'object'
    AND jsonb_typeof(consistency_result) = 'object'
  ),
  CONSTRAINT chk_customs_declaration_versions_fingerprint
    CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_customs_declaration_versions_files
    CHECK (pre_entry_file_id <> authorization_file_id)
);

CREATE INDEX idx_customs_declaration_versions_tenant_set
  ON customs_declaration_versions (tenant_id, declaration_set_id, version DESC);

CREATE TABLE customs_declaration_operations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sales_order_id uuid NOT NULL,
  declaration_set_id uuid NOT NULL,
  operation_type varchar(16) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  result_json jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_customs_declaration_operations_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_customs_declaration_operations_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_customs_declaration_operations_order
    FOREIGN KEY (tenant_id, sales_order_id)
    REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customs_declaration_operations_set
    FOREIGN KEY (tenant_id, declaration_set_id)
    REFERENCES customs_declaration_sets(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customs_declaration_operations_creator
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_customs_declaration_operations_type
    CHECK (operation_type IN ('create', 'refresh', 'generate', 'export')),
  CONSTRAINT chk_customs_declaration_operations_key CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT chk_customs_declaration_operations_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_customs_declaration_operations_result CHECK (jsonb_typeof(result_json) = 'object')
);

CREATE INDEX idx_customs_declaration_operations_tenant_set
  ON customs_declaration_operations (tenant_id, declaration_set_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_customs_archive_modification()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customs declaration archives are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_modify_customs_declaration_versions
  BEFORE UPDATE OR DELETE ON customs_declaration_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_customs_archive_modification();
CREATE TRIGGER no_modify_customs_declaration_operations
  BEFORE UPDATE OR DELETE ON customs_declaration_operations
  FOR EACH ROW EXECUTE FUNCTION prevent_customs_archive_modification();

ALTER TABLE customs_declaration_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE customs_declaration_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE customs_declaration_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE customs_declaration_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE customs_declaration_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE customs_declaration_operations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON customs_declaration_sets FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON customs_declaration_versions FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON customs_declaration_operations FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON customs_declaration_sets TO kirindesk_app;
GRANT SELECT, INSERT ON customs_declaration_versions, customs_declaration_operations
  TO kirindesk_app;
REVOKE DELETE ON customs_declaration_sets FROM kirindesk_app;
REVOKE UPDATE, DELETE ON customs_declaration_versions, customs_declaration_operations
  FROM kirindesk_app;

INSERT INTO permissions (module_id, code, name, action)
SELECT module.id, permission.code, permission.name, permission.action
  FROM (
    VALUES
      ('orders', 'customs_declarations:view', '查看报关资料', 'view'),
      ('orders', 'customs_declarations:manage', '维护报关资料', 'manage'),
      ('orders', 'customs_declarations:export', '导出报关资料', 'export')
  ) AS permission(module_code, code, name, action)
  JOIN modules module ON module.code = permission.module_code
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
SELECT source_grant.tenant_id, source_grant.role_id, target_permission.id, source_grant.data_scope
  FROM role_permissions source_grant
  JOIN permissions source_permission ON source_permission.id = source_grant.permission_id
  JOIN (
    VALUES
      ('fulfillment:view', 'customs_declarations:view'),
      ('document_sets:manage', 'customs_declarations:manage'),
      ('document_sets:export', 'customs_declarations:export')
  ) AS permission_map(source_code, target_code)
    ON permission_map.source_code = source_permission.code
  JOIN permissions target_permission ON target_permission.code = permission_map.target_code
ON CONFLICT (tenant_id, role_id, permission_id) DO NOTHING;

-- DOWN
DELETE FROM role_permissions
 WHERE permission_id IN (
   SELECT id FROM permissions
    WHERE code IN (
      'customs_declarations:view',
      'customs_declarations:manage',
      'customs_declarations:export'
    )
 );
DELETE FROM permissions
 WHERE code IN (
   'customs_declarations:view',
   'customs_declarations:manage',
   'customs_declarations:export'
 );

DROP TRIGGER IF EXISTS no_modify_customs_declaration_operations
  ON customs_declaration_operations;
DROP TRIGGER IF EXISTS no_modify_customs_declaration_versions
  ON customs_declaration_versions;
DROP FUNCTION IF EXISTS prevent_customs_archive_modification();
DROP TABLE IF EXISTS customs_declaration_operations CASCADE;
DROP TABLE IF EXISTS customs_declaration_versions CASCADE;
DROP TABLE IF EXISTS customs_declaration_sets CASCADE;
