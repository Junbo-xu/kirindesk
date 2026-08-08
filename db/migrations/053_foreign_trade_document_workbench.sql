-- UP
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_user_id uuid NOT NULL,
  sku varchar(100) NOT NULL,
  name varchar(300) NOT NULL,
  description text,
  unit varchar(32) NOT NULL,
  hs_code varchar(32),
  default_currency varchar(3) NOT NULL DEFAULT 'USD',
  default_unit_price numeric(18,4) NOT NULL DEFAULT 0,
  cost_unit_price numeric(18,4),
  weight_kg numeric(18,4),
  volume_cbm numeric(18,6),
  thumbnail_file_id uuid,
  custom_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_products_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_products_tenant_sku UNIQUE (tenant_id, sku),
  CONSTRAINT fk_products_owner
    FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_products_thumbnail
    FOREIGN KEY (tenant_id, thumbnail_file_id) REFERENCES files(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_products_currency CHECK (default_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_products_prices CHECK (
    default_unit_price >= 0 AND (cost_unit_price IS NULL OR cost_unit_price >= 0)
  ),
  CONSTRAINT chk_products_measurements CHECK (
    (weight_kg IS NULL OR weight_kg >= 0) AND (volume_cbm IS NULL OR volume_cbm >= 0)
  ),
  CONSTRAINT chk_products_custom_values CHECK (jsonb_typeof(custom_values) = 'object')
);

CREATE INDEX idx_products_tenant_active ON products (tenant_id, active, updated_at DESC);

CREATE TABLE product_custom_fields (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  field_key varchar(64) NOT NULL,
  label varchar(120) NOT NULL,
  data_type varchar(20) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  document_types varchar(16)[] NOT NULL DEFAULT ARRAY['quote','pi','sc','ci','pl']::varchar[],
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_product_custom_fields_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_product_custom_fields_key UNIQUE (tenant_id, field_key),
  CONSTRAINT fk_product_custom_fields_creator
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_product_custom_fields_key CHECK (field_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT chk_product_custom_fields_type
    CHECK (data_type IN ('text', 'number', 'boolean', 'date')),
  CONSTRAINT chk_product_custom_fields_sort CHECK (sort_order >= 0),
  CONSTRAINT chk_product_custom_fields_documents CHECK (
    document_types <@ ARRAY['quote','pi','sc','ci','pl']::varchar[]
  )
);

CREATE INDEX idx_product_custom_fields_tenant_sort
  ON product_custom_fields (tenant_id, active, sort_order, created_at);

CREATE TABLE trade_document_sets (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_user_id uuid NOT NULL,
  customer_id uuid,
  sales_order_id uuid,
  quote_number varchar(64) NOT NULL,
  pricing_mode varchar(24) NOT NULL DEFAULT 'final_price',
  status varchar(16) NOT NULL DEFAULT 'draft',
  language varchar(8) NOT NULL DEFAULT 'en',
  incoterm varchar(8) NOT NULL DEFAULT 'FOB',
  pricing_currency varchar(3) NOT NULL DEFAULT 'USD',
  settlement_currency varchar(3) NOT NULL DEFAULT 'USD',
  exchange_rate numeric(20,10) NOT NULL DEFAULT 1,
  discount_type varchar(16) NOT NULL DEFAULT 'none',
  discount_value numeric(18,4) NOT NULL DEFAULT 0,
  freight_amount numeric(18,2) NOT NULL DEFAULT 0,
  insurance_amount numeric(18,2) NOT NULL DEFAULT 0,
  tax_amount numeric(18,2) NOT NULL DEFAULT 0,
  internal_expenses numeric(18,2) NOT NULL DEFAULT 0,
  allocation_method varchar(16) NOT NULL DEFAULT 'value',
  packing_mode varchar(16) NOT NULL DEFAULT 'normal',
  template_key varchar(40) NOT NULL DEFAULT 'fixed_default',
  theme_color varchar(7) NOT NULL DEFAULT '#155EEF',
  visible_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  terms text,
  bank_info text,
  logo_file_id uuid,
  signature_file_id uuid,
  version integer NOT NULL DEFAULT 1,
  locked_snapshot jsonb,
  locked_by uuid,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_trade_document_sets_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_trade_document_sets_number UNIQUE (tenant_id, quote_number),
  CONSTRAINT fk_trade_document_sets_owner
    FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_trade_document_sets_customer
    FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_trade_document_sets_sales_order
    FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_trade_document_sets_logo
    FOREIGN KEY (tenant_id, logo_file_id) REFERENCES files(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_trade_document_sets_signature
    FOREIGN KEY (tenant_id, signature_file_id) REFERENCES files(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_trade_document_sets_locked_by
    FOREIGN KEY (tenant_id, locked_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_trade_document_sets_mode
    CHECK (pricing_mode IN ('final_price', 'cost_profit')),
  CONSTRAINT chk_trade_document_sets_status CHECK (status IN ('draft', 'locked')),
  CONSTRAINT chk_trade_document_sets_language CHECK (language IN ('zh','en','ru','es','de','ar')),
  CONSTRAINT chk_trade_document_sets_incoterm CHECK (incoterm IN ('FOB','CIF','EXW')),
  CONSTRAINT chk_trade_document_sets_currency CHECK (
    pricing_currency ~ '^[A-Z]{3}$' AND settlement_currency ~ '^[A-Z]{3}$'
  ),
  CONSTRAINT chk_trade_document_sets_exchange_rate CHECK (exchange_rate > 0),
  CONSTRAINT chk_trade_document_sets_discount_type
    CHECK (discount_type IN ('none', 'percent', 'amount')),
  CONSTRAINT chk_trade_document_sets_amounts CHECK (
    discount_value >= 0 AND freight_amount >= 0 AND insurance_amount >= 0
    AND tax_amount >= 0 AND internal_expenses >= 0
  ),
  CONSTRAINT chk_trade_document_sets_allocation
    CHECK (allocation_method IN ('equal', 'value', 'weight', 'volume')),
  CONSTRAINT chk_trade_document_sets_packing CHECK (packing_mode IN ('normal', 'combined')),
  CONSTRAINT chk_trade_document_sets_template CHECK (template_key = 'fixed_default'),
  CONSTRAINT chk_trade_document_sets_theme CHECK (theme_color ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT chk_trade_document_sets_visible_fields CHECK (jsonb_typeof(visible_fields) = 'object'),
  CONSTRAINT chk_trade_document_sets_version CHECK (version > 0),
  CONSTRAINT chk_trade_document_sets_lock CHECK (
    (status = 'draft' AND locked_snapshot IS NULL AND locked_by IS NULL AND locked_at IS NULL)
    OR
    (status = 'locked' AND jsonb_typeof(locked_snapshot) = 'object'
      AND locked_by IS NOT NULL AND locked_at IS NOT NULL)
  )
);

CREATE INDEX idx_trade_document_sets_tenant_owner
  ON trade_document_sets (tenant_id, owner_user_id, updated_at DESC);
CREATE INDEX idx_trade_document_sets_tenant_customer
  ON trade_document_sets (tenant_id, customer_id, updated_at DESC);

CREATE TABLE trade_document_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_set_id uuid NOT NULL,
  product_id uuid,
  line_no integer NOT NULL,
  sku varchar(100) NOT NULL,
  name varchar(300) NOT NULL,
  description text,
  quantity numeric(18,3) NOT NULL,
  unit varchar(32) NOT NULL,
  unit_price numeric(18,4) NOT NULL,
  line_total numeric(18,2) NOT NULL,
  cost_unit_price numeric(18,4),
  cost_total numeric(18,2),
  weight_kg numeric(18,4),
  volume_cbm numeric(18,6),
  package_no varchar(64),
  thumbnail_file_id uuid,
  custom_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_trade_document_lines_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_trade_document_lines_number UNIQUE (tenant_id, document_set_id, line_no),
  CONSTRAINT fk_trade_document_lines_set
    FOREIGN KEY (tenant_id, document_set_id)
    REFERENCES trade_document_sets(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_trade_document_lines_product
    FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_trade_document_lines_thumbnail
    FOREIGN KEY (tenant_id, thumbnail_file_id) REFERENCES files(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_trade_document_lines_number CHECK (line_no > 0),
  CONSTRAINT chk_trade_document_lines_quantity CHECK (quantity > 0),
  CONSTRAINT chk_trade_document_lines_price CHECK (unit_price >= 0 AND line_total >= 0),
  CONSTRAINT chk_trade_document_lines_cost CHECK (
    (cost_unit_price IS NULL AND cost_total IS NULL)
    OR (cost_unit_price >= 0 AND cost_total >= 0)
  ),
  CONSTRAINT chk_trade_document_lines_measurements CHECK (
    (weight_kg IS NULL OR weight_kg >= 0) AND (volume_cbm IS NULL OR volume_cbm >= 0)
  ),
  CONSTRAINT chk_trade_document_lines_custom_values CHECK (jsonb_typeof(custom_values) = 'object')
);

CREATE INDEX idx_trade_document_lines_set
  ON trade_document_lines (tenant_id, document_set_id, line_no);

CREATE TABLE trade_document_exports (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_set_id uuid NOT NULL,
  source_version integer NOT NULL,
  export_version integer NOT NULL,
  document_type varchar(16) NOT NULL,
  snapshot_json jsonb NOT NULL,
  file_id uuid NOT NULL,
  is_draft boolean NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_trade_document_exports_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_trade_document_exports_version
    UNIQUE (tenant_id, document_set_id, document_type, export_version),
  CONSTRAINT fk_trade_document_exports_set
    FOREIGN KEY (tenant_id, document_set_id)
    REFERENCES trade_document_sets(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_trade_document_exports_file
    FOREIGN KEY (tenant_id, file_id) REFERENCES files(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_trade_document_exports_creator
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_trade_document_exports_source_version CHECK (source_version > 0),
  CONSTRAINT chk_trade_document_exports_export_version CHECK (export_version > 0),
  CONSTRAINT chk_trade_document_exports_type
    CHECK (document_type IN ('quote','pi','sc','ci','pl')),
  CONSTRAINT chk_trade_document_exports_snapshot CHECK (jsonb_typeof(snapshot_json) = 'object')
);

CREATE INDEX idx_trade_document_exports_set
  ON trade_document_exports (tenant_id, document_set_id, created_at DESC);

CREATE TABLE trade_document_share_links (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  export_id uuid NOT NULL,
  token_hash varchar(64) NOT NULL,
  created_by uuid NOT NULL,
  revoked_by uuid,
  revoked_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_trade_document_share_links_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_trade_document_share_links_token UNIQUE (token_hash),
  CONSTRAINT fk_trade_document_share_links_export
    FOREIGN KEY (tenant_id, export_id) REFERENCES trade_document_exports(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_trade_document_share_links_creator
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_trade_document_share_links_revoker
    FOREIGN KEY (tenant_id, revoked_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_trade_document_share_links_token CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_trade_document_share_links_revocation CHECK (
    (revoked_by IS NULL AND revoked_at IS NULL) OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX idx_trade_document_share_links_export
  ON trade_document_share_links (tenant_id, export_id, created_at DESC);

CREATE TABLE trade_document_public_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  share_link_id uuid NOT NULL,
  event_type varchar(16) NOT NULL,
  ip_hash varchar(64),
  user_agent varchar(500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_trade_document_public_events_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT fk_trade_document_public_events_link
    FOREIGN KEY (tenant_id, share_link_id)
    REFERENCES trade_document_share_links(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_trade_document_public_events_type
    CHECK (event_type IN ('opened','downloaded','confirmed')),
  CONSTRAINT chk_trade_document_public_events_ip CHECK (
    ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX idx_trade_document_public_events_link
  ON trade_document_public_events (tenant_id, share_link_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_locked_trade_document_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'locked' THEN
    RAISE EXCEPTION 'locked trade document sets are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_update_locked_trade_document_sets
  BEFORE UPDATE ON trade_document_sets
  FOR EACH ROW EXECUTE FUNCTION prevent_locked_trade_document_mutation();

CREATE OR REPLACE FUNCTION prevent_locked_trade_document_line_mutation()
RETURNS trigger AS $$
DECLARE
  target_document_set_id uuid;
BEGIN
  target_document_set_id := COALESCE(NEW.document_set_id, OLD.document_set_id);
  IF EXISTS (
    SELECT 1 FROM trade_document_sets
     WHERE id = target_document_set_id AND status = 'locked'
  ) THEN
    RAISE EXCEPTION 'lines of locked trade document sets are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_mutate_locked_trade_document_lines
  BEFORE INSERT OR UPDATE OR DELETE ON trade_document_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_locked_trade_document_line_mutation();

CREATE OR REPLACE FUNCTION prevent_trade_document_export_modification()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'trade document exports are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_modify_trade_document_exports
  BEFORE UPDATE OR DELETE ON trade_document_exports
  FOR EACH ROW EXECUTE FUNCTION prevent_trade_document_export_modification();

CREATE OR REPLACE FUNCTION prevent_trade_document_public_event_modification()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'trade document public events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_modify_trade_document_public_events
  BEFORE UPDATE OR DELETE ON trade_document_public_events
  FOR EACH ROW EXECUTE FUNCTION prevent_trade_document_public_event_modification();

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
ALTER TABLE product_custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_custom_fields FORCE ROW LEVEL SECURITY;
ALTER TABLE trade_document_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_document_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE trade_document_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_document_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE trade_document_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_document_exports FORCE ROW LEVEL SECURITY;
ALTER TABLE trade_document_share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_document_share_links FORCE ROW LEVEL SECURITY;
ALTER TABLE trade_document_public_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_document_public_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON products FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON product_custom_fields FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON trade_document_sets FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON trade_document_lines FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON trade_document_exports FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON trade_document_share_links FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON trade_document_public_events FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE OR REPLACE FUNCTION app_lookup_trade_document_link(p_token_hash varchar)
RETURNS TABLE (tenant_id uuid, link_id uuid)
AS $$
  SELECT tenant_id, id
    FROM trade_document_share_links
   WHERE token_hash = p_token_hash
     AND revoked_at IS NULL;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION app_lookup_trade_document_link(varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_lookup_trade_document_link(varchar) TO kirindesk_app;

GRANT SELECT, INSERT, UPDATE ON products TO kirindesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_custom_fields TO kirindesk_app;
GRANT SELECT, INSERT, UPDATE ON trade_document_sets TO kirindesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON trade_document_lines TO kirindesk_app;
GRANT SELECT, INSERT ON trade_document_exports TO kirindesk_app;
GRANT SELECT, INSERT, UPDATE ON trade_document_share_links TO kirindesk_app;
GRANT SELECT, INSERT ON trade_document_public_events TO kirindesk_app;

INSERT INTO permissions (module_id, code, name, action)
SELECT module.id, permission.code, permission.name, permission.action
  FROM (
    VALUES
      ('orders', 'products:view', '查看产品库', 'view'),
      ('orders', 'products:manage', '维护产品库', 'manage'),
      ('system', 'product_fields:manage', '配置产品字段', 'manage'),
      ('orders', 'document_sets:view', '查看外贸单证', 'view'),
      ('orders', 'document_sets:manage', '维护外贸单证', 'manage'),
      ('orders', 'document_sets:lock', '锁定外贸单证', 'lock'),
      ('orders', 'document_sets:export', '导出外贸单证', 'export'),
      ('orders', 'document_links:manage', '管理客户追踪链接', 'manage'),
      ('finance', 'document_financials:view', '查看单证成本利润', 'view')
  ) AS permission(module_code, code, name, action)
  JOIN modules module ON module.code = permission.module_code
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
SELECT source_grant.tenant_id, source_grant.role_id, target_permission.id, source_grant.data_scope
  FROM role_permissions source_grant
  JOIN permissions source_permission ON source_permission.id = source_grant.permission_id
  JOIN (
    VALUES
      ('inquiries:view', 'products:view'),
      ('inquiries:create', 'products:manage'),
      ('tenant_settings:update', 'product_fields:manage'),
      ('proforma_invoices:view', 'document_sets:view'),
      ('proforma_invoices:create', 'document_sets:manage'),
      ('proforma_invoices:issue', 'document_sets:lock'),
      ('proforma_invoices:export', 'document_sets:export'),
      ('proforma_invoices:export', 'document_links:manage'),
      ('profit_snapshots:create', 'document_financials:view')
  ) AS permission_map(source_code, target_code)
    ON permission_map.source_code = source_permission.code
  JOIN permissions target_permission ON target_permission.code = permission_map.target_code
ON CONFLICT (tenant_id, role_id, permission_id) DO NOTHING;

-- DOWN
DELETE FROM role_permissions
 WHERE permission_id IN (
   SELECT id FROM permissions
    WHERE code IN (
      'products:view','products:manage','product_fields:manage','document_sets:view',
      'document_sets:manage','document_sets:lock','document_sets:export',
      'document_links:manage','document_financials:view'
    )
 );
DELETE FROM permissions
 WHERE code IN (
   'products:view','products:manage','product_fields:manage','document_sets:view',
   'document_sets:manage','document_sets:lock','document_sets:export',
   'document_links:manage','document_financials:view'
 );
DROP FUNCTION IF EXISTS app_lookup_trade_document_link(varchar);
DROP TABLE IF EXISTS trade_document_public_events CASCADE;
DROP FUNCTION IF EXISTS prevent_trade_document_public_event_modification();
DROP TABLE IF EXISTS trade_document_share_links CASCADE;
DROP TABLE IF EXISTS trade_document_exports CASCADE;
DROP FUNCTION IF EXISTS prevent_trade_document_export_modification();
DROP TABLE IF EXISTS trade_document_lines CASCADE;
DROP FUNCTION IF EXISTS prevent_locked_trade_document_line_mutation();
DROP TABLE IF EXISTS trade_document_sets CASCADE;
DROP FUNCTION IF EXISTS prevent_locked_trade_document_mutation();
DROP TABLE IF EXISTS product_custom_fields CASCADE;
DROP TABLE IF EXISTS products CASCADE;
