-- UP

ALTER TABLE customers
  ADD CONSTRAINT uq_customers_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE files
  ADD CONSTRAINT uq_files_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE sales_orders
  ADD CONSTRAINT uq_sales_orders_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE quote_selection_snapshots
  ADD CONSTRAINT uq_quote_selection_snapshots_tenant_id_id UNIQUE (tenant_id, id);

ALTER TABLE inquiries
  ADD COLUMN customer_id uuid,
  ADD CONSTRAINT fk_inquiries_customer
    FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE quote_selection_snapshots
  ADD COLUMN sales_currency varchar(3),
  ADD COLUMN sales_unit_price numeric(18,4),
  ADD COLUMN purchase_to_sales_fx_rate numeric(18,8),
  ADD COLUMN fx_rate_source varchar(20),
  ADD COLUMN fx_captured_at timestamptz,
  ADD COLUMN purchase_unit_cost numeric(18,4),
  ADD COLUMN gross_profit_unit numeric(18,4),
  ADD COLUMN gross_margin_bps integer,
  ADD COLUMN margin_threshold_bps integer,
  ADD COLUMN margin_status varchar(24),
  ADD COLUMN margin_formula_version varchar(40),
  ADD CONSTRAINT chk_quote_selection_sales_currency
    CHECK (sales_currency IS NULL OR sales_currency IN ('RMB', 'USD', 'HKD', 'EUR')),
  ADD CONSTRAINT chk_quote_selection_sales_unit_price
    CHECK (sales_unit_price IS NULL OR sales_unit_price > 0),
  ADD CONSTRAINT chk_quote_selection_fx_rate
    CHECK (purchase_to_sales_fx_rate IS NULL OR purchase_to_sales_fx_rate > 0),
  ADD CONSTRAINT chk_quote_selection_threshold
    CHECK (margin_threshold_bps IS NULL OR margin_threshold_bps BETWEEN -100000 AND 10000),
  ADD CONSTRAINT chk_quote_selection_margin_status
    CHECK (margin_status IS NULL OR margin_status IN ('meets_threshold', 'below_threshold')),
  ADD CONSTRAINT chk_quote_selection_commercial_snapshot CHECK (
    (sales_currency IS NULL AND sales_unit_price IS NULL AND purchase_to_sales_fx_rate IS NULL
      AND fx_rate_source IS NULL AND fx_captured_at IS NULL AND purchase_unit_cost IS NULL
      AND gross_profit_unit IS NULL AND gross_margin_bps IS NULL AND margin_threshold_bps IS NULL
      AND margin_status IS NULL AND margin_formula_version IS NULL)
    OR
    (sales_currency IS NOT NULL AND sales_unit_price IS NOT NULL
      AND purchase_to_sales_fx_rate IS NOT NULL AND fx_rate_source IS NOT NULL
      AND fx_captured_at IS NOT NULL AND purchase_unit_cost IS NOT NULL
      AND gross_profit_unit IS NOT NULL AND gross_margin_bps IS NOT NULL
      AND margin_threshold_bps IS NOT NULL AND margin_status IS NOT NULL
      AND margin_formula_version IS NOT NULL)
  );

CREATE TABLE quote_selection_margin_approvals (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  selection_id uuid NOT NULL,
  approved_by uuid NOT NULL,
  reason varchar(1000) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_quote_selection_margin_approvals_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_quote_selection_margin_approval UNIQUE (tenant_id, selection_id),
  CONSTRAINT fk_quote_selection_margin_approval_selection
    FOREIGN KEY (tenant_id, selection_id)
    REFERENCES quote_selection_snapshots(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_quote_selection_margin_approval_user
    FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_quote_selection_margin_approval_reason CHECK (btrim(reason) <> '')
);

CREATE TABLE proforma_invoices (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  series_id uuid NOT NULL DEFAULT uuid_generate_v4(),
  inquiry_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  sales_order_id uuid,
  pi_number varchar(64) NOT NULL,
  version integer NOT NULL,
  currency varchar(3) NOT NULL,
  payment_terms varchar(2000) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'draft',
  total_amount numeric(18,2) NOT NULL,
  created_by uuid NOT NULL,
  issued_by uuid,
  issued_at timestamptz,
  confirmed_by uuid,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_proforma_invoices_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_proforma_invoices_series_version UNIQUE (tenant_id, series_id, version),
  CONSTRAINT uq_proforma_invoices_number_version UNIQUE (tenant_id, pi_number, version),
  CONSTRAINT uq_proforma_invoices_sales_order UNIQUE (tenant_id, sales_order_id),
  CONSTRAINT fk_proforma_invoices_inquiry
    FOREIGN KEY (tenant_id, inquiry_id) REFERENCES inquiries(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_proforma_invoices_customer
    FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_proforma_invoices_sales_order
    FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_proforma_invoices_created_by
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_proforma_invoices_issued_by
    FOREIGN KEY (tenant_id, issued_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_proforma_invoices_confirmed_by
    FOREIGN KEY (tenant_id, confirmed_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_proforma_invoices_version CHECK (version > 0),
  CONSTRAINT chk_proforma_invoices_currency CHECK (currency IN ('RMB', 'USD', 'HKD', 'EUR')),
  CONSTRAINT chk_proforma_invoices_total CHECK (total_amount > 0),
  CONSTRAINT chk_proforma_invoices_terms CHECK (btrim(payment_terms) <> ''),
  CONSTRAINT chk_proforma_invoices_status
    CHECK (status IN ('draft', 'issued', 'customer_confirmed')),
  CONSTRAINT chk_proforma_invoices_issued CHECK (
    (status = 'draft' AND issued_by IS NULL AND issued_at IS NULL)
    OR (status IN ('issued', 'customer_confirmed') AND issued_by IS NOT NULL AND issued_at IS NOT NULL)
  ),
  CONSTRAINT chk_proforma_invoices_confirmed CHECK (
    (status <> 'customer_confirmed' AND confirmed_by IS NULL AND confirmed_at IS NULL
      AND sales_order_id IS NULL)
    OR (status = 'customer_confirmed' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
      AND sales_order_id IS NOT NULL)
  )
);

CREATE INDEX idx_proforma_invoices_tenant_inquiry
  ON proforma_invoices (tenant_id, inquiry_id, created_at DESC);
CREATE INDEX idx_proforma_invoices_tenant_status
  ON proforma_invoices (tenant_id, status, created_at DESC);

CREATE TABLE proforma_invoice_series_selections (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  series_id uuid NOT NULL,
  selection_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_pi_series_selections_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_pi_series_selection UNIQUE (tenant_id, series_id, selection_id),
  CONSTRAINT uq_pi_selection_allocation UNIQUE (tenant_id, selection_id),
  CONSTRAINT fk_pi_series_selection_selection
    FOREIGN KEY (tenant_id, selection_id)
    REFERENCES quote_selection_snapshots(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE proforma_invoice_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  proforma_invoice_id uuid NOT NULL,
  series_id uuid NOT NULL,
  selection_id uuid NOT NULL,
  line_no integer NOT NULL,
  description varchar(500) NOT NULL,
  specifications text,
  quantity numeric(18,3) NOT NULL,
  unit varchar(32) NOT NULL,
  unit_price numeric(18,4) NOT NULL,
  line_total numeric(18,2) NOT NULL,
  selection_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_proforma_invoice_items_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_proforma_invoice_item_line UNIQUE (tenant_id, proforma_invoice_id, line_no),
  CONSTRAINT uq_proforma_invoice_item_selection UNIQUE (tenant_id, proforma_invoice_id, selection_id),
  CONSTRAINT fk_proforma_invoice_item_pi
    FOREIGN KEY (tenant_id, proforma_invoice_id)
    REFERENCES proforma_invoices(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_proforma_invoice_item_allocation
    FOREIGN KEY (tenant_id, series_id, selection_id)
    REFERENCES proforma_invoice_series_selections(tenant_id, series_id, selection_id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_proforma_invoice_item_line CHECK (line_no > 0),
  CONSTRAINT chk_proforma_invoice_item_quantity CHECK (quantity > 0),
  CONSTRAINT chk_proforma_invoice_item_unit_price CHECK (unit_price > 0),
  CONSTRAINT chk_proforma_invoice_item_total CHECK (line_total > 0),
  CONSTRAINT chk_proforma_invoice_item_snapshot CHECK (jsonb_typeof(selection_snapshot) = 'object')
);

CREATE INDEX idx_proforma_invoice_items_tenant_pi
  ON proforma_invoice_items (tenant_id, proforma_invoice_id, line_no);

ALTER TABLE sales_orders DROP CONSTRAINT chk_sales_orders_status;
ALTER TABLE sales_orders
  ADD COLUMN inquiry_id uuid,
  ADD COLUMN source_pi_id uuid,
  ADD CONSTRAINT fk_sales_orders_inquiry
    FOREIGN KEY (tenant_id, inquiry_id) REFERENCES inquiries(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_sales_orders_source_pi
    FOREIGN KEY (tenant_id, source_pi_id)
    REFERENCES proforma_invoices(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT uq_sales_orders_source_pi UNIQUE (tenant_id, source_pi_id),
  ADD CONSTRAINT chk_sales_orders_status CHECK (
    status IN (
      'draft', 'pending_approval', 'approved', 'rejected', 'confirmed', 'completed',
      'customer_confirmed', 'payment_gate_open', 'procurement', 'fulfillment',
      'delivered', 'finance_review', 'settled', 'cancelled', 'on_hold'
    )
  ),
  ADD CONSTRAINT chk_sales_orders_pi_source CHECK (
    (source_pi_id IS NULL AND inquiry_id IS NULL)
    OR (source_pi_id IS NOT NULL AND inquiry_id IS NOT NULL)
  );

CREATE TABLE customer_receipts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  proforma_invoice_id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  amount numeric(18,2) NOT NULL,
  currency varchar(3) NOT NULL,
  received_at date NOT NULL,
  method varchar(40) NOT NULL,
  external_reference varchar(120) NOT NULL,
  proof_file_id uuid,
  recorded_by uuid NOT NULL,
  note varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_customer_receipts_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_customer_receipt_reference
    UNIQUE (tenant_id, proforma_invoice_id, method, external_reference),
  CONSTRAINT fk_customer_receipts_pi
    FOREIGN KEY (tenant_id, proforma_invoice_id)
    REFERENCES proforma_invoices(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_receipts_order
    FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_receipts_proof
    FOREIGN KEY (tenant_id, proof_file_id) REFERENCES files(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_receipts_recorded_by
    FOREIGN KEY (tenant_id, recorded_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_customer_receipts_amount CHECK (amount > 0),
  CONSTRAINT chk_customer_receipts_currency CHECK (currency IN ('RMB', 'USD', 'HKD', 'EUR')),
  CONSTRAINT chk_customer_receipts_method CHECK (
    method IN ('bank_transfer', 'cash', 'card_external', 'other_external')
  ),
  CONSTRAINT chk_customer_receipts_reference CHECK (btrim(external_reference) <> '')
);

CREATE INDEX idx_customer_receipts_tenant_order
  ON customer_receipts (tenant_id, sales_order_id, created_at DESC);

CREATE TABLE customer_receipt_decisions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  receipt_id uuid NOT NULL,
  decision varchar(16) NOT NULL,
  decided_by uuid NOT NULL,
  reason varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_customer_receipt_decisions_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_customer_receipt_decision UNIQUE (tenant_id, receipt_id),
  CONSTRAINT fk_customer_receipt_decision_receipt
    FOREIGN KEY (tenant_id, receipt_id) REFERENCES customer_receipts(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_receipt_decision_user
    FOREIGN KEY (tenant_id, decided_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_customer_receipt_decision CHECK (decision IN ('confirmed', 'rejected')),
  CONSTRAINT chk_customer_receipt_rejection_reason CHECK (
    decision <> 'rejected' OR (reason IS NOT NULL AND btrim(reason) <> '')
  )
);

CREATE TABLE procurement_gate_evaluations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sales_order_id uuid NOT NULL,
  proforma_invoice_id uuid NOT NULL,
  status varchar(16) NOT NULL,
  order_amount numeric(18,2) NOT NULL,
  confirmed_amount numeric(18,2) NOT NULL,
  required_amount numeric(18,2) NOT NULL,
  currency varchar(3) NOT NULL,
  required_ratio_bps integer NOT NULL,
  proof_required boolean NOT NULL,
  config_enabled boolean NOT NULL,
  bypass_reason varchar(1000),
  blocking_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  evaluated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_procurement_gate_evaluations_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT fk_procurement_gate_evaluation_order
    FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_gate_evaluation_pi
    FOREIGN KEY (tenant_id, proforma_invoice_id)
    REFERENCES proforma_invoices(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_gate_evaluation_user
    FOREIGN KEY (tenant_id, evaluated_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_procurement_gate_status CHECK (status IN ('blocked', 'open', 'bypassed')),
  CONSTRAINT chk_procurement_gate_amounts CHECK (
    order_amount > 0 AND confirmed_amount >= 0 AND required_amount >= 0
  ),
  CONSTRAINT chk_procurement_gate_ratio CHECK (required_ratio_bps BETWEEN 0 AND 10000),
  CONSTRAINT chk_procurement_gate_currency CHECK (currency IN ('RMB', 'USD', 'HKD', 'EUR')),
  CONSTRAINT chk_procurement_gate_reasons CHECK (jsonb_typeof(blocking_reasons) = 'array'),
  CONSTRAINT chk_procurement_gate_bypass CHECK (
    (status = 'bypassed' AND config_enabled = false AND bypass_reason IS NOT NULL
      AND btrim(bypass_reason) <> '')
    OR (status <> 'bypassed' AND config_enabled = true AND bypass_reason IS NULL)
  )
);

CREATE INDEX idx_procurement_gate_evaluations_tenant_order
  ON procurement_gate_evaluations (tenant_id, sales_order_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION prevent_stage_2b_append_only_modification()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_modify_quote_selection_margin_approvals
  BEFORE UPDATE OR DELETE ON quote_selection_margin_approvals
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2b_append_only_modification();
CREATE TRIGGER no_modify_proforma_invoice_series_selections
  BEFORE UPDATE OR DELETE ON proforma_invoice_series_selections
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2b_append_only_modification();
CREATE TRIGGER no_modify_proforma_invoice_items
  BEFORE UPDATE OR DELETE ON proforma_invoice_items
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2b_append_only_modification();
CREATE TRIGGER no_modify_customer_receipts
  BEFORE UPDATE OR DELETE ON customer_receipts
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2b_append_only_modification();
CREATE TRIGGER no_modify_customer_receipt_decisions
  BEFORE UPDATE OR DELETE ON customer_receipt_decisions
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2b_append_only_modification();
CREATE TRIGGER no_modify_procurement_gate_evaluations
  BEFORE UPDATE OR DELETE ON procurement_gate_evaluations
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2b_append_only_modification();

CREATE OR REPLACE FUNCTION protect_proforma_invoice_content()
RETURNS trigger AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.series_id IS DISTINCT FROM NEW.series_id
    OR OLD.inquiry_id IS DISTINCT FROM NEW.inquiry_id
    OR OLD.customer_id IS DISTINCT FROM NEW.customer_id
    OR OLD.pi_number IS DISTINCT FROM NEW.pi_number
    OR OLD.version IS DISTINCT FROM NEW.version
    OR OLD.currency IS DISTINCT FROM NEW.currency
    OR OLD.payment_terms IS DISTINCT FROM NEW.payment_terms
    OR OLD.total_amount IS DISTINCT FROM NEW.total_amount
    OR OLD.created_by IS DISTINCT FROM NEW.created_by
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'proforma invoice commercial content is immutable';
  END IF;
  IF NOT (
    (OLD.status = 'draft' AND NEW.status = 'issued')
    OR (OLD.status = 'issued' AND NEW.status = 'customer_confirmed')
  ) THEN
    RAISE EXCEPTION 'invalid proforma invoice status transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'issued'
    AND (
      OLD.issued_by IS DISTINCT FROM NEW.issued_by
      OR OLD.issued_at IS DISTINCT FROM NEW.issued_at
    ) THEN
    RAISE EXCEPTION 'proforma invoice issuance facts are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_proforma_invoice_content_trigger
  BEFORE UPDATE ON proforma_invoices
  FOR EACH ROW EXECUTE FUNCTION protect_proforma_invoice_content();

ALTER TABLE quote_selection_margin_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_selection_margin_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE proforma_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE proforma_invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE proforma_invoice_series_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE proforma_invoice_series_selections FORCE ROW LEVEL SECURITY;
ALTER TABLE proforma_invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE proforma_invoice_items FORCE ROW LEVEL SECURITY;
ALTER TABLE customer_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE customer_receipt_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_receipt_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE procurement_gate_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_gate_evaluations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON quote_selection_margin_approvals FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON proforma_invoices FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON proforma_invoice_series_selections FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON proforma_invoice_items FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON customer_receipts FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON customer_receipt_decisions FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON procurement_gate_evaluations FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT ON quote_selection_margin_approvals TO kirindesk_app;
GRANT SELECT, INSERT, UPDATE ON proforma_invoices TO kirindesk_app;
GRANT SELECT, INSERT ON proforma_invoice_series_selections TO kirindesk_app;
GRANT SELECT, INSERT ON proforma_invoice_items TO kirindesk_app;
GRANT SELECT, INSERT ON customer_receipts TO kirindesk_app;
GRANT SELECT, INSERT ON customer_receipt_decisions TO kirindesk_app;
GRANT SELECT, INSERT ON procurement_gate_evaluations TO kirindesk_app;

REVOKE UPDATE, DELETE ON quote_selection_margin_approvals FROM kirindesk_app;
REVOKE UPDATE, DELETE ON proforma_invoice_series_selections FROM kirindesk_app;
REVOKE UPDATE, DELETE ON proforma_invoice_items FROM kirindesk_app;
REVOKE UPDATE, DELETE ON customer_receipts FROM kirindesk_app;
REVOKE UPDATE, DELETE ON customer_receipt_decisions FROM kirindesk_app;
REVOKE UPDATE, DELETE ON procurement_gate_evaluations FROM kirindesk_app;

-- DOWN
DROP TRIGGER IF EXISTS protect_proforma_invoice_content_trigger ON proforma_invoices;
DROP FUNCTION IF EXISTS protect_proforma_invoice_content();
DROP TABLE IF EXISTS procurement_gate_evaluations CASCADE;
DROP TABLE IF EXISTS customer_receipt_decisions CASCADE;
DROP TABLE IF EXISTS customer_receipts CASCADE;
UPDATE sales_orders
   SET status = CASE
     WHEN status IN ('customer_confirmed', 'payment_gate_open', 'procurement') THEN 'confirmed'
     WHEN status IN ('fulfillment', 'delivered', 'finance_review', 'settled') THEN 'completed'
     WHEN status = 'on_hold' THEN 'draft'
     ELSE status
   END
 WHERE status IN (
   'customer_confirmed', 'payment_gate_open', 'procurement', 'fulfillment',
   'delivered', 'finance_review', 'settled', 'on_hold'
 );
ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS chk_sales_orders_pi_source;
ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS chk_sales_orders_status;
ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS uq_sales_orders_source_pi;
ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS fk_sales_orders_source_pi;
ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS fk_sales_orders_inquiry;
ALTER TABLE sales_orders DROP COLUMN IF EXISTS source_pi_id;
ALTER TABLE sales_orders DROP COLUMN IF EXISTS inquiry_id;
ALTER TABLE sales_orders
  ADD CONSTRAINT chk_sales_orders_status
    CHECK (status IN ('draft','pending_approval','approved','rejected','confirmed','completed','cancelled'));
DROP TABLE IF EXISTS proforma_invoice_items CASCADE;
DROP TABLE IF EXISTS proforma_invoice_series_selections CASCADE;
DROP TABLE IF EXISTS proforma_invoices CASCADE;
DROP TABLE IF EXISTS quote_selection_margin_approvals CASCADE;
DROP FUNCTION IF EXISTS prevent_stage_2b_append_only_modification();
ALTER TABLE quote_selection_snapshots
  DROP CONSTRAINT IF EXISTS chk_quote_selection_commercial_snapshot,
  DROP CONSTRAINT IF EXISTS chk_quote_selection_margin_status,
  DROP CONSTRAINT IF EXISTS chk_quote_selection_threshold,
  DROP CONSTRAINT IF EXISTS chk_quote_selection_fx_rate,
  DROP CONSTRAINT IF EXISTS chk_quote_selection_sales_unit_price,
  DROP CONSTRAINT IF EXISTS chk_quote_selection_sales_currency,
  DROP COLUMN IF EXISTS margin_formula_version,
  DROP COLUMN IF EXISTS margin_status,
  DROP COLUMN IF EXISTS margin_threshold_bps,
  DROP COLUMN IF EXISTS gross_margin_bps,
  DROP COLUMN IF EXISTS gross_profit_unit,
  DROP COLUMN IF EXISTS purchase_unit_cost,
  DROP COLUMN IF EXISTS fx_captured_at,
  DROP COLUMN IF EXISTS fx_rate_source,
  DROP COLUMN IF EXISTS purchase_to_sales_fx_rate,
  DROP COLUMN IF EXISTS sales_unit_price,
  DROP COLUMN IF EXISTS sales_currency;
ALTER TABLE inquiries DROP CONSTRAINT IF EXISTS fk_inquiries_customer;
ALTER TABLE inquiries DROP COLUMN IF EXISTS customer_id;
ALTER TABLE quote_selection_snapshots
  DROP CONSTRAINT IF EXISTS uq_quote_selection_snapshots_tenant_id_id;
ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS uq_sales_orders_tenant_id_id;
ALTER TABLE files DROP CONSTRAINT IF EXISTS uq_files_tenant_id_id;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS uq_customers_tenant_id_id;
