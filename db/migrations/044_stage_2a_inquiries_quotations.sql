-- UP
-- Stage 2A: inquiry -> sanitized sourcing task -> current supplier quotation
-- -> immutable selection snapshot. Composite keys enforce tenant ownership at
-- every relationship boundary; FORCE RLS is the second, independent boundary.

ALTER TABLE users
  ADD CONSTRAINT uq_users_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE suppliers
  ADD CONSTRAINT uq_suppliers_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE provider_invocations
  ADD CONSTRAINT uq_provider_invocations_tenant_id_id UNIQUE (tenant_id, id);

CREATE TABLE inquiries (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_user_id uuid NOT NULL,
  customer_code varchar(100) NOT NULL,
  customer_country varchar(100) NOT NULL,
  customer_message text NOT NULL,
  source_version integer NOT NULL DEFAULT 1,
  status varchar(20) NOT NULL DEFAULT 'draft',
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_inquiries_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT fk_inquiries_owner
    FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_inquiries_source_version CHECK (source_version > 0),
  CONSTRAINT chk_inquiries_status
    CHECK (status IN ('draft', 'submitted', 'quoting', 'quoted', 'selected')),
  CONSTRAINT chk_inquiries_submitted_at
    CHECK ((status = 'draft' AND submitted_at IS NULL) OR (status <> 'draft' AND submitted_at IS NOT NULL))
);

CREATE INDEX idx_inquiries_tenant_owner ON inquiries (tenant_id, owner_user_id);
CREATE INDEX idx_inquiries_tenant_status ON inquiries (tenant_id, status);

CREATE TABLE inquiry_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  inquiry_id uuid NOT NULL,
  line_no integer NOT NULL,
  description varchar(500) NOT NULL,
  specifications text,
  quantity numeric(18,3) NOT NULL,
  unit varchar(32) NOT NULL,
  target_price_usd numeric(18,4),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_inquiry_items_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_inquiry_items_tenant_inquiry_id UNIQUE (tenant_id, inquiry_id, id),
  CONSTRAINT fk_inquiry_items_inquiry
    FOREIGN KEY (tenant_id, inquiry_id) REFERENCES inquiries(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_inquiry_items_line UNIQUE (tenant_id, inquiry_id, line_no),
  CONSTRAINT chk_inquiry_items_line_no CHECK (line_no > 0),
  CONSTRAINT chk_inquiry_items_quantity CHECK (quantity > 0),
  CONSTRAINT chk_inquiry_items_target_price CHECK (target_price_usd IS NULL OR target_price_usd >= 0)
);

CREATE INDEX idx_inquiry_items_tenant_inquiry ON inquiry_items (tenant_id, inquiry_id);

CREATE TABLE quote_tasks (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  inquiry_id uuid NOT NULL,
  sanitization_status varchar(24) NOT NULL DEFAULT 'pending',
  sanitized_summary text,
  sanitized_payload jsonb,
  provider_name varchar(50),
  provider_invocation_id uuid,
  last_error_code varchar(40),
  attempt_count integer NOT NULL DEFAULT 0,
  corrected_by uuid,
  corrected_at timestamptz,
  last_attempted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_quote_tasks_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_quote_tasks_inquiry UNIQUE (tenant_id, inquiry_id),
  CONSTRAINT fk_quote_tasks_inquiry
    FOREIGN KEY (tenant_id, inquiry_id) REFERENCES inquiries(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_quote_tasks_provider_invocation
    FOREIGN KEY (tenant_id, provider_invocation_id)
    REFERENCES provider_invocations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_quote_tasks_corrected_by
    FOREIGN KEY (tenant_id, corrected_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_quote_tasks_status CHECK (
    sanitization_status IN (
      'pending', 'processing', 'ready', 'timeout', 'rate_limited',
      'parse_failed', 'provider_failed', 'manually_corrected'
    )
  ),
  CONSTRAINT chk_quote_tasks_attempt_count CHECK (attempt_count >= 0),
  CONSTRAINT chk_quote_tasks_payload_shape CHECK (
    sanitized_payload IS NULL OR jsonb_typeof(sanitized_payload) = 'object'
  ),
  CONSTRAINT chk_quote_tasks_ready_payload CHECK (
    sanitization_status NOT IN ('ready', 'manually_corrected')
    OR (sanitized_summary IS NOT NULL AND sanitized_payload IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX idx_quote_tasks_tenant_status ON quote_tasks (tenant_id, sanitization_status);

CREATE TABLE supplier_quotations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  inquiry_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  entered_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  currency varchar(3) NOT NULL,
  valid_until date NOT NULL,
  source_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_supplier_quotations_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_supplier_quotations_tenant_inquiry_id UNIQUE (tenant_id, inquiry_id, id),
  CONSTRAINT uq_supplier_quotations_current UNIQUE (tenant_id, inquiry_id, supplier_id),
  CONSTRAINT fk_supplier_quotations_inquiry
    FOREIGN KEY (tenant_id, inquiry_id) REFERENCES inquiries(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_supplier_quotations_supplier
    FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_supplier_quotations_entered_by
    FOREIGN KEY (tenant_id, entered_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_supplier_quotations_version CHECK (version > 0),
  CONSTRAINT chk_supplier_quotations_currency CHECK (currency IN ('RMB', 'USD', 'HKD', 'EUR'))
);

CREATE INDEX idx_supplier_quotations_tenant_inquiry
  ON supplier_quotations (tenant_id, inquiry_id);

CREATE TABLE supplier_quotation_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  inquiry_id uuid NOT NULL,
  quotation_id uuid NOT NULL,
  inquiry_item_id uuid NOT NULL,
  variant_key varchar(100) NOT NULL DEFAULT '',
  variant_value varchar(200) NOT NULL DEFAULT '',
  quantity numeric(18,3) NOT NULL,
  unit_price numeric(18,4) NOT NULL,
  minimum_quantity numeric(18,3),
  lead_time_days integer,
  terms varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_supplier_quotation_lines_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_supplier_quotation_lines_tenant_inquiry_quote_id
    UNIQUE (tenant_id, inquiry_id, quotation_id, id),
  CONSTRAINT fk_supplier_quotation_lines_quotation
    FOREIGN KEY (tenant_id, inquiry_id, quotation_id)
    REFERENCES supplier_quotations(tenant_id, inquiry_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_supplier_quotation_lines_item
    FOREIGN KEY (tenant_id, inquiry_id, inquiry_item_id)
    REFERENCES inquiry_items(tenant_id, inquiry_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_supplier_quotation_lines_variant
    UNIQUE (tenant_id, quotation_id, inquiry_item_id, variant_key, variant_value),
  CONSTRAINT chk_supplier_quotation_lines_quantity CHECK (quantity > 0),
  CONSTRAINT chk_supplier_quotation_lines_unit_price CHECK (unit_price >= 0),
  CONSTRAINT chk_supplier_quotation_lines_minimum_quantity
    CHECK (minimum_quantity IS NULL OR minimum_quantity > 0),
  CONSTRAINT chk_supplier_quotation_lines_lead_time
    CHECK (lead_time_days IS NULL OR lead_time_days >= 0)
);

CREATE INDEX idx_supplier_quotation_lines_tenant_quote
  ON supplier_quotation_lines (tenant_id, quotation_id);
CREATE INDEX idx_supplier_quotation_lines_tenant_item
  ON supplier_quotation_lines (tenant_id, inquiry_item_id);

CREATE TABLE quote_selection_snapshots (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  inquiry_id uuid NOT NULL,
  inquiry_item_id uuid NOT NULL,
  quotation_id uuid NOT NULL,
  quotation_line_id uuid NOT NULL,
  quotation_version integer NOT NULL,
  selected_by uuid NOT NULL,
  snapshot_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_quote_selection_snapshots_inquiry
    FOREIGN KEY (tenant_id, inquiry_id) REFERENCES inquiries(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_quote_selection_snapshots_item
    FOREIGN KEY (tenant_id, inquiry_id, inquiry_item_id)
    REFERENCES inquiry_items(tenant_id, inquiry_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_quote_selection_snapshots_selected_by
    FOREIGN KEY (tenant_id, selected_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_quote_selection_snapshots_item UNIQUE (tenant_id, inquiry_item_id),
  CONSTRAINT chk_quote_selection_snapshots_version CHECK (quotation_version > 0),
  CONSTRAINT chk_quote_selection_snapshots_payload CHECK (jsonb_typeof(snapshot_json) = 'object')
);

CREATE INDEX idx_quote_selection_snapshots_tenant_inquiry
  ON quote_selection_snapshots (tenant_id, inquiry_id);

CREATE OR REPLACE FUNCTION prevent_quote_selection_snapshot_modification()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'quote_selection_snapshots is immutable: % is forbidden', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_modify_quote_selection_snapshots
  BEFORE UPDATE OR DELETE ON quote_selection_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_quote_selection_snapshot_modification();

ALTER TABLE inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiries FORCE ROW LEVEL SECURITY;
ALTER TABLE inquiry_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiry_items FORCE ROW LEVEL SECURITY;
ALTER TABLE quote_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_quotations FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_quotation_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_quotation_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE quote_selection_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_selection_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON inquiries FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON inquiry_items FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON quote_tasks FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON supplier_quotations FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON supplier_quotation_lines FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON quote_selection_snapshots FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON inquiries TO kirindesk_app;
GRANT SELECT, INSERT ON inquiry_items TO kirindesk_app;
GRANT SELECT, INSERT, UPDATE ON quote_tasks TO kirindesk_app;
GRANT SELECT, INSERT, UPDATE ON supplier_quotations TO kirindesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_quotation_lines TO kirindesk_app;
GRANT SELECT, INSERT ON quote_selection_snapshots TO kirindesk_app;
REVOKE UPDATE, DELETE ON quote_selection_snapshots FROM kirindesk_app;

-- DOWN
DROP TABLE IF EXISTS quote_selection_snapshots CASCADE;
DROP FUNCTION IF EXISTS prevent_quote_selection_snapshot_modification();
DROP TABLE IF EXISTS supplier_quotation_lines CASCADE;
DROP TABLE IF EXISTS supplier_quotations CASCADE;
DROP TABLE IF EXISTS quote_tasks CASCADE;
DROP TABLE IF EXISTS inquiry_items CASCADE;
DROP TABLE IF EXISTS inquiries CASCADE;
ALTER TABLE provider_invocations DROP CONSTRAINT IF EXISTS uq_provider_invocations_tenant_id_id;
ALTER TABLE suppliers DROP CONSTRAINT IF EXISTS uq_suppliers_tenant_id_id;
ALTER TABLE users DROP CONSTRAINT IF EXISTS uq_users_tenant_id_id;
