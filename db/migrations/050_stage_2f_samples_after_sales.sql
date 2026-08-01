-- UP
-- Stage 2F: independent sample-order lifecycle and append-only after-sales
-- adjustments. All tenant relationships use composite foreign keys and every
-- new tenant table is protected by FORCE RLS.

CREATE TABLE sample_orders (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  inquiry_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  sample_number varchar(64) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'draft',
  recipient_name varchar(120) NOT NULL,
  recipient_phone varchar(60) NOT NULL,
  recipient_address varchar(1000) NOT NULL,
  recipient_country varchar(100) NOT NULL,
  shipping_fee numeric(18,2) NOT NULL DEFAULT 0,
  shipping_currency varchar(3) NOT NULL,
  note varchar(1000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sample_orders_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_sample_orders_number UNIQUE (tenant_id, sample_number),
  CONSTRAINT fk_sample_orders_inquiry
    FOREIGN KEY (tenant_id, inquiry_id) REFERENCES inquiries(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sample_orders_customer
    FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sample_orders_owner
    FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sample_orders_creator
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_sample_orders_status CHECK (
    status IN (
      'draft','pending_approval','approved','rejected','dispatched','delivered',
      'confirmed','converted','closed'
    )
  ),
  CONSTRAINT chk_sample_orders_recipient CHECK (
    btrim(recipient_name) <> '' AND btrim(recipient_phone) <> ''
    AND btrim(recipient_address) <> '' AND btrim(recipient_country) <> ''
  ),
  CONSTRAINT chk_sample_orders_shipping CHECK (
    shipping_fee >= 0 AND shipping_currency IN ('RMB','USD','HKD','EUR')
  )
);

CREATE INDEX idx_sample_orders_tenant_owner
  ON sample_orders (tenant_id, owner_user_id, created_at DESC);
CREATE INDEX idx_sample_orders_tenant_status
  ON sample_orders (tenant_id, status, created_at DESC);

CREATE TABLE sample_order_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sample_order_id uuid NOT NULL,
  inquiry_item_id uuid NOT NULL,
  source_selection_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  line_no integer NOT NULL,
  description varchar(500) NOT NULL,
  specifications text,
  sample_quantity numeric(18,3) NOT NULL,
  maximum_conversion_quantity numeric(18,3) NOT NULL,
  unit varchar(32) NOT NULL,
  sales_currency varchar(3) NOT NULL,
  sales_unit_price numeric(18,4) NOT NULL,
  purchase_unit_cost numeric(18,4) NOT NULL,
  purchase_to_sales_fx_rate numeric(18,8) NOT NULL,
  fx_rate_source varchar(120) NOT NULL,
  fx_captured_at timestamptz NOT NULL,
  gross_profit_unit numeric(18,4) NOT NULL,
  gross_margin_bps integer NOT NULL,
  margin_threshold_bps integer NOT NULL,
  margin_status varchar(24) NOT NULL,
  margin_formula_version varchar(40) NOT NULL,
  source_quotation_id uuid NOT NULL,
  source_quotation_line_id uuid NOT NULL,
  source_quotation_version integer NOT NULL,
  source_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sample_order_items_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_sample_order_item_line UNIQUE (tenant_id, sample_order_id, line_no),
  CONSTRAINT uq_sample_order_item_selection UNIQUE (tenant_id, sample_order_id, source_selection_id),
  CONSTRAINT fk_sample_order_items_order
    FOREIGN KEY (tenant_id, sample_order_id)
    REFERENCES sample_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sample_order_items_inquiry_item
    FOREIGN KEY (tenant_id, inquiry_item_id)
    REFERENCES inquiry_items(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sample_order_items_selection
    FOREIGN KEY (tenant_id, source_selection_id)
    REFERENCES quote_selection_snapshots(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sample_order_items_supplier
    FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_sample_order_items_line CHECK (line_no > 0),
  CONSTRAINT chk_sample_order_items_quantity CHECK (
    sample_quantity > 0 AND maximum_conversion_quantity > 0
    AND sample_quantity <= maximum_conversion_quantity
  ),
  CONSTRAINT chk_sample_order_items_money CHECK (
    sales_unit_price > 0 AND purchase_unit_cost >= 0 AND purchase_to_sales_fx_rate > 0
  ),
  CONSTRAINT chk_sample_order_items_currency
    CHECK (sales_currency IN ('RMB','USD','HKD','EUR')),
  CONSTRAINT chk_sample_order_items_margin
    CHECK (margin_status IN ('meets_threshold','below_threshold')),
  CONSTRAINT chk_sample_order_items_snapshot CHECK (jsonb_typeof(source_snapshot) = 'object')
);

CREATE INDEX idx_sample_order_items_source
  ON sample_order_items (tenant_id, source_selection_id);

CREATE TABLE sample_order_approvals (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sample_order_id uuid NOT NULL,
  decision varchar(16) NOT NULL,
  reason varchar(1000),
  decided_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sample_order_approvals_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_sample_order_approval UNIQUE (tenant_id, sample_order_id),
  CONSTRAINT fk_sample_order_approvals_order
    FOREIGN KEY (tenant_id, sample_order_id)
    REFERENCES sample_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sample_order_approvals_user
    FOREIGN KEY (tenant_id, decided_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_sample_order_approval_decision CHECK (decision IN ('approved','rejected')),
  CONSTRAINT chk_sample_order_approval_reason CHECK (
    decision = 'approved' OR (reason IS NOT NULL AND btrim(reason) <> '')
  )
);

CREATE TABLE sample_shipments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sample_order_id uuid NOT NULL,
  carrier varchar(120) NOT NULL,
  tracking_number varchar(120) NOT NULL,
  dispatched_by uuid NOT NULL,
  dispatched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sample_shipments_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_sample_shipment_order UNIQUE (tenant_id, sample_order_id),
  CONSTRAINT uq_sample_shipment_tracking UNIQUE (tenant_id, carrier, tracking_number),
  CONSTRAINT fk_sample_shipments_order
    FOREIGN KEY (tenant_id, sample_order_id)
    REFERENCES sample_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sample_shipments_user
    FOREIGN KEY (tenant_id, dispatched_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_sample_shipments_fields CHECK (
    btrim(carrier) <> '' AND btrim(tracking_number) <> ''
  )
);

CREATE TABLE sample_delivery_confirmations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sample_order_id uuid NOT NULL,
  shipment_id uuid NOT NULL,
  received_by varchar(120) NOT NULL,
  delivered_at timestamptz NOT NULL,
  confirmed_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sample_delivery_confirmations_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_sample_delivery_order UNIQUE (tenant_id, sample_order_id),
  CONSTRAINT uq_sample_delivery_shipment UNIQUE (tenant_id, shipment_id),
  CONSTRAINT fk_sample_delivery_order
    FOREIGN KEY (tenant_id, sample_order_id)
    REFERENCES sample_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sample_delivery_shipment
    FOREIGN KEY (tenant_id, shipment_id)
    REFERENCES sample_shipments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sample_delivery_user
    FOREIGN KEY (tenant_id, confirmed_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_sample_delivery_receiver CHECK (btrim(received_by) <> '')
);

CREATE TABLE sample_customer_feedback (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sample_order_id uuid NOT NULL,
  feedback varchar(2000) NOT NULL,
  confirmed_by uuid NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sample_customer_feedback_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_sample_customer_feedback_order UNIQUE (tenant_id, sample_order_id),
  CONSTRAINT fk_sample_customer_feedback_order
    FOREIGN KEY (tenant_id, sample_order_id)
    REFERENCES sample_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sample_customer_feedback_user
    FOREIGN KEY (tenant_id, confirmed_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_sample_customer_feedback_text CHECK (btrim(feedback) <> '')
);

CREATE TABLE sample_order_closures (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sample_order_id uuid NOT NULL,
  reason varchar(1000) NOT NULL,
  closed_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sample_order_closures_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_sample_order_closure UNIQUE (tenant_id, sample_order_id),
  CONSTRAINT fk_sample_order_closures_order
    FOREIGN KEY (tenant_id, sample_order_id)
    REFERENCES sample_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sample_order_closures_user
    FOREIGN KEY (tenant_id, closed_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_sample_order_closure_reason CHECK (btrim(reason) <> '')
);

ALTER TABLE inquiries ADD COLUMN source_sample_order_id uuid;
ALTER TABLE inquiries
  ADD CONSTRAINT fk_inquiries_source_sample_order
    FOREIGN KEY (tenant_id, source_sample_order_id)
    REFERENCES sample_orders(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT uq_inquiries_source_sample_order UNIQUE (tenant_id, source_sample_order_id);

CREATE TABLE sample_order_conversions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sample_order_id uuid NOT NULL,
  inquiry_id uuid NOT NULL,
  proforma_invoice_id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  snapshot jsonb NOT NULL,
  converted_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sample_order_conversions_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_sample_order_conversion UNIQUE (tenant_id, sample_order_id),
  CONSTRAINT uq_sample_order_conversion_inquiry UNIQUE (tenant_id, inquiry_id),
  CONSTRAINT uq_sample_order_conversion_pi UNIQUE (tenant_id, proforma_invoice_id),
  CONSTRAINT uq_sample_order_conversion_sales_order UNIQUE (tenant_id, sales_order_id),
  CONSTRAINT fk_sample_order_conversions_sample
    FOREIGN KEY (tenant_id, sample_order_id)
    REFERENCES sample_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sample_order_conversions_inquiry
    FOREIGN KEY (tenant_id, inquiry_id) REFERENCES inquiries(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sample_order_conversions_pi
    FOREIGN KEY (tenant_id, proforma_invoice_id)
    REFERENCES proforma_invoices(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sample_order_conversions_order
    FOREIGN KEY (tenant_id, sales_order_id)
    REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sample_order_conversions_user
    FOREIGN KEY (tenant_id, converted_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_sample_order_conversions_snapshot CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE TABLE after_sales_approval_configs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  version integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_after_sales_configs_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_after_sales_configs_version UNIQUE (tenant_id, version),
  CONSTRAINT fk_after_sales_configs_user
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_after_sales_configs_version CHECK (version > 0)
);

CREATE UNIQUE INDEX uq_after_sales_active_config
  ON after_sales_approval_configs (tenant_id) WHERE active;

CREATE TABLE after_sales_approval_config_steps (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  config_id uuid NOT NULL,
  step_no integer NOT NULL,
  approver_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_after_sales_config_steps_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_after_sales_config_step UNIQUE (tenant_id, config_id, step_no),
  CONSTRAINT uq_after_sales_config_approver UNIQUE (tenant_id, config_id, approver_user_id),
  CONSTRAINT fk_after_sales_config_steps_config
    FOREIGN KEY (tenant_id, config_id)
    REFERENCES after_sales_approval_configs(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_after_sales_config_steps_user
    FOREIGN KEY (tenant_id, approver_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_after_sales_config_steps_number CHECK (step_no > 0)
);

CREATE TABLE after_sales_cases (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sales_order_id uuid NOT NULL,
  shipment_id uuid,
  case_number varchar(64) NOT NULL,
  case_type varchar(20) NOT NULL,
  responsibility varchar(24) NOT NULL,
  reason varchar(2000) NOT NULL,
  requested_amount numeric(18,2) NOT NULL,
  currency varchar(3) NOT NULL,
  proof_file_id uuid,
  status varchar(24) NOT NULL DEFAULT 'draft',
  requested_by uuid NOT NULL,
  approval_config_id uuid NOT NULL,
  approval_config_version integer NOT NULL,
  completed_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_after_sales_cases_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_after_sales_cases_number UNIQUE (tenant_id, case_number),
  CONSTRAINT fk_after_sales_cases_order
    FOREIGN KEY (tenant_id, sales_order_id)
    REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_after_sales_cases_shipment
    FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_after_sales_cases_requester
    FOREIGN KEY (tenant_id, requested_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_after_sales_cases_config
    FOREIGN KEY (tenant_id, approval_config_id)
    REFERENCES after_sales_approval_configs(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_after_sales_cases_proof
    FOREIGN KEY (tenant_id, proof_file_id) REFERENCES files(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_after_sales_cases_type CHECK (case_type IN ('refund','compensation')),
  CONSTRAINT chk_after_sales_cases_responsibility CHECK (
    responsibility IN ('supplier','logistics','company','customer','undetermined')
  ),
  CONSTRAINT chk_after_sales_cases_status CHECK (
    status IN ('draft','pending_approval','approved','rejected','executing','completed','closed')
  ),
  CONSTRAINT chk_after_sales_cases_reason CHECK (btrim(reason) <> ''),
  CONSTRAINT chk_after_sales_cases_amount CHECK (requested_amount > 0),
  CONSTRAINT chk_after_sales_cases_currency CHECK (currency IN ('RMB','USD','HKD','EUR')),
  CONSTRAINT chk_after_sales_cases_completion CHECK (
    (status NOT IN ('completed','closed') AND completed_at IS NULL)
    OR (status IN ('completed','closed') AND completed_at IS NOT NULL)
  ),
  CONSTRAINT chk_after_sales_cases_closed CHECK (
    (status = 'closed' AND closed_at IS NOT NULL) OR (status <> 'closed' AND closed_at IS NULL)
  )
);

CREATE INDEX idx_after_sales_cases_tenant_order
  ON after_sales_cases (tenant_id, sales_order_id, created_at DESC);
CREATE INDEX idx_after_sales_cases_tenant_status
  ON after_sales_cases (tenant_id, status, created_at DESC);

CREATE TABLE after_sales_case_approval_steps (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  case_id uuid NOT NULL,
  config_step_id uuid NOT NULL,
  step_no integer NOT NULL,
  approver_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_after_sales_case_steps_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_after_sales_case_step UNIQUE (tenant_id, case_id, step_no),
  CONSTRAINT uq_after_sales_case_approver UNIQUE (tenant_id, case_id, approver_user_id),
  CONSTRAINT fk_after_sales_case_steps_case
    FOREIGN KEY (tenant_id, case_id)
    REFERENCES after_sales_cases(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_after_sales_case_steps_config
    FOREIGN KEY (tenant_id, config_step_id)
    REFERENCES after_sales_approval_config_steps(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_after_sales_case_steps_user
    FOREIGN KEY (tenant_id, approver_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_after_sales_case_steps_number CHECK (step_no > 0)
);

CREATE TABLE after_sales_case_decisions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  case_id uuid NOT NULL,
  approval_step_id uuid NOT NULL,
  step_no integer NOT NULL,
  decision varchar(16) NOT NULL,
  decided_by uuid NOT NULL,
  reason varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_after_sales_case_decisions_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_after_sales_case_decision_step UNIQUE (tenant_id, approval_step_id),
  CONSTRAINT fk_after_sales_case_decisions_case
    FOREIGN KEY (tenant_id, case_id)
    REFERENCES after_sales_cases(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_after_sales_case_decisions_step
    FOREIGN KEY (tenant_id, approval_step_id)
    REFERENCES after_sales_case_approval_steps(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_after_sales_case_decisions_user
    FOREIGN KEY (tenant_id, decided_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_after_sales_case_decisions_number CHECK (step_no > 0),
  CONSTRAINT chk_after_sales_case_decisions_decision CHECK (decision IN ('approved','rejected')),
  CONSTRAINT chk_after_sales_case_decisions_reason CHECK (
    decision = 'approved' OR (reason IS NOT NULL AND btrim(reason) <> '')
  )
);

CREATE TABLE after_sales_adjustments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  case_id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  adjustment_type varchar(20) NOT NULL,
  amount numeric(18,2) NOT NULL,
  currency varchar(3) NOT NULL,
  fx_rate_to_rmb numeric(20,8) NOT NULL,
  fx_source varchar(120) NOT NULL,
  fx_captured_at timestamptz NOT NULL,
  amount_rmb numeric(18,2) NOT NULL,
  external_reference varchar(160) NOT NULL,
  proof_file_id uuid,
  executed_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_after_sales_adjustments_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_after_sales_adjustment_case UNIQUE (tenant_id, case_id),
  CONSTRAINT uq_after_sales_adjustment_reference UNIQUE (tenant_id, external_reference),
  CONSTRAINT fk_after_sales_adjustments_case
    FOREIGN KEY (tenant_id, case_id)
    REFERENCES after_sales_cases(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_after_sales_adjustments_order
    FOREIGN KEY (tenant_id, sales_order_id)
    REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_after_sales_adjustments_proof
    FOREIGN KEY (tenant_id, proof_file_id) REFERENCES files(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_after_sales_adjustments_user
    FOREIGN KEY (tenant_id, executed_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_after_sales_adjustments_type CHECK (adjustment_type IN ('refund','compensation')),
  CONSTRAINT chk_after_sales_adjustments_money CHECK (
    amount > 0 AND fx_rate_to_rmb > 0 AND amount_rmb > 0
  ),
  CONSTRAINT chk_after_sales_adjustments_currency CHECK (currency IN ('RMB','USD','HKD','EUR')),
  CONSTRAINT chk_after_sales_adjustments_fields CHECK (
    btrim(fx_source) <> '' AND btrim(external_reference) <> ''
  )
);

ALTER TABLE finance_review_items DROP CONSTRAINT chk_finance_review_items_subject;
ALTER TABLE finance_review_items DROP CONSTRAINT chk_finance_review_items_money;
ALTER TABLE finance_review_items
  ADD CONSTRAINT chk_finance_review_items_subject CHECK (
    subject_type IN (
      'customer_receipt','purchase_cost','order_expense','after_sales_adjustment',
      'missing_receipt','missing_cost','missing_freight','missing_fx'
    )
  ),
  ADD CONSTRAINT chk_finance_review_items_money CHECK (
    (
      subject_type IN (
        'customer_receipt','purchase_cost','order_expense','after_sales_adjustment'
      )
      AND subject_id IS NOT NULL AND source_amount IS NOT NULL AND source_amount >= 0
      AND source_currency IS NOT NULL AND fx_rate_to_rmb IS NOT NULL AND fx_rate_to_rmb > 0
      AND fx_source IS NOT NULL AND btrim(fx_source) <> '' AND fx_captured_at IS NOT NULL
      AND amount_rmb IS NOT NULL AND amount_rmb >= 0
    )
    OR
    (
      subject_type IN ('missing_receipt','missing_cost','missing_freight','missing_fx')
      AND subject_id IS NULL AND source_amount IS NULL AND source_currency IS NULL
      AND fx_rate_to_rmb IS NULL AND fx_source IS NULL AND fx_captured_at IS NULL
      AND amount_rmb IS NULL AND decision = 'returned'
    )
  );

CREATE OR REPLACE FUNCTION prevent_stage_2f_append_only_modification()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_modify_sample_order_items BEFORE UPDATE OR DELETE ON sample_order_items
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2f_append_only_modification();
CREATE TRIGGER no_modify_sample_order_approvals BEFORE UPDATE OR DELETE ON sample_order_approvals
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2f_append_only_modification();
CREATE TRIGGER no_modify_sample_shipments BEFORE UPDATE OR DELETE ON sample_shipments
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2f_append_only_modification();
CREATE TRIGGER no_modify_sample_deliveries BEFORE UPDATE OR DELETE ON sample_delivery_confirmations
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2f_append_only_modification();
CREATE TRIGGER no_modify_sample_feedback BEFORE UPDATE OR DELETE ON sample_customer_feedback
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2f_append_only_modification();
CREATE TRIGGER no_modify_sample_closures BEFORE UPDATE OR DELETE ON sample_order_closures
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2f_append_only_modification();
CREATE TRIGGER no_modify_sample_conversions BEFORE UPDATE OR DELETE ON sample_order_conversions
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2f_append_only_modification();
CREATE TRIGGER no_modify_after_sales_config_steps BEFORE UPDATE OR DELETE ON after_sales_approval_config_steps
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2f_append_only_modification();
CREATE TRIGGER no_modify_after_sales_case_steps BEFORE UPDATE OR DELETE ON after_sales_case_approval_steps
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2f_append_only_modification();
CREATE TRIGGER no_modify_after_sales_decisions BEFORE UPDATE OR DELETE ON after_sales_case_decisions
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2f_append_only_modification();
CREATE TRIGGER no_modify_after_sales_adjustments BEFORE UPDATE OR DELETE ON after_sales_adjustments
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2f_append_only_modification();

CREATE OR REPLACE FUNCTION protect_sample_order_content()
RETURNS trigger AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.inquiry_id IS DISTINCT FROM NEW.inquiry_id
    OR OLD.customer_id IS DISTINCT FROM NEW.customer_id
    OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR OLD.sample_number IS DISTINCT FROM NEW.sample_number
    OR OLD.recipient_name IS DISTINCT FROM NEW.recipient_name
    OR OLD.recipient_phone IS DISTINCT FROM NEW.recipient_phone
    OR OLD.recipient_address IS DISTINCT FROM NEW.recipient_address
    OR OLD.recipient_country IS DISTINCT FROM NEW.recipient_country
    OR OLD.shipping_fee IS DISTINCT FROM NEW.shipping_fee
    OR OLD.shipping_currency IS DISTINCT FROM NEW.shipping_currency
    OR OLD.note IS DISTINCT FROM NEW.note
    OR OLD.created_by IS DISTINCT FROM NEW.created_by
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'sample order source content is immutable';
  END IF;
  IF NOT (
    (OLD.status = 'draft' AND NEW.status = 'pending_approval')
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('approved','rejected'))
    OR (OLD.status = 'approved' AND NEW.status IN ('dispatched','closed'))
    OR (OLD.status = 'dispatched' AND NEW.status IN ('delivered','closed'))
    OR (OLD.status = 'delivered' AND NEW.status IN ('confirmed','closed'))
    OR (OLD.status = 'confirmed' AND NEW.status IN ('converted','closed'))
  ) THEN
    RAISE EXCEPTION 'invalid sample order status transition: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_sample_order_content_trigger BEFORE UPDATE ON sample_orders
  FOR EACH ROW EXECUTE FUNCTION protect_sample_order_content();

CREATE OR REPLACE FUNCTION protect_after_sales_case_content()
RETURNS trigger AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.sales_order_id IS DISTINCT FROM NEW.sales_order_id
    OR OLD.shipment_id IS DISTINCT FROM NEW.shipment_id
    OR OLD.case_number IS DISTINCT FROM NEW.case_number
    OR OLD.case_type IS DISTINCT FROM NEW.case_type
    OR OLD.responsibility IS DISTINCT FROM NEW.responsibility
    OR OLD.reason IS DISTINCT FROM NEW.reason
    OR OLD.requested_amount IS DISTINCT FROM NEW.requested_amount
    OR OLD.currency IS DISTINCT FROM NEW.currency
    OR OLD.proof_file_id IS DISTINCT FROM NEW.proof_file_id
    OR OLD.requested_by IS DISTINCT FROM NEW.requested_by
    OR OLD.approval_config_id IS DISTINCT FROM NEW.approval_config_id
    OR OLD.approval_config_version IS DISTINCT FROM NEW.approval_config_version
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'after-sales case source content is immutable';
  END IF;
  IF NOT (
    (OLD.status = 'draft' AND NEW.status = 'pending_approval')
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('approved','rejected'))
    OR (OLD.status = 'approved' AND NEW.status = 'executing')
    OR (OLD.status = 'executing' AND NEW.status = 'completed')
    OR (OLD.status = 'completed' AND NEW.status = 'closed')
  ) THEN
    RAISE EXCEPTION 'invalid after-sales status transition: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_after_sales_case_content_trigger BEFORE UPDATE ON after_sales_cases
  FOR EACH ROW EXECUTE FUNCTION protect_after_sales_case_content();

ALTER TABLE sample_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE sample_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_order_items FORCE ROW LEVEL SECURITY;
ALTER TABLE sample_order_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_order_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE sample_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_shipments FORCE ROW LEVEL SECURITY;
ALTER TABLE sample_delivery_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_delivery_confirmations FORCE ROW LEVEL SECURITY;
ALTER TABLE sample_customer_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_customer_feedback FORCE ROW LEVEL SECURITY;
ALTER TABLE sample_order_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_order_closures FORCE ROW LEVEL SECURITY;
ALTER TABLE sample_order_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_order_conversions FORCE ROW LEVEL SECURITY;
ALTER TABLE after_sales_approval_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE after_sales_approval_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE after_sales_approval_config_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE after_sales_approval_config_steps FORCE ROW LEVEL SECURITY;
ALTER TABLE after_sales_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE after_sales_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE after_sales_case_approval_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE after_sales_case_approval_steps FORCE ROW LEVEL SECURITY;
ALTER TABLE after_sales_case_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE after_sales_case_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE after_sales_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE after_sales_adjustments FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON sample_orders FOR ALL
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON sample_order_items FOR ALL
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON sample_order_approvals FOR ALL
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON sample_shipments FOR ALL
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON sample_delivery_confirmations FOR ALL
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON sample_customer_feedback FOR ALL
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON sample_order_closures FOR ALL
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON sample_order_conversions FOR ALL
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON after_sales_approval_configs FOR ALL
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON after_sales_approval_config_steps FOR ALL
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON after_sales_cases FOR ALL
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON after_sales_case_approval_steps FOR ALL
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON after_sales_case_decisions FOR ALL
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON after_sales_adjustments FOR ALL
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON sample_orders TO kirindesk_app;
GRANT SELECT, INSERT ON sample_order_items, sample_order_approvals, sample_shipments,
  sample_delivery_confirmations, sample_customer_feedback, sample_order_closures,
  sample_order_conversions TO kirindesk_app;
GRANT SELECT, INSERT, UPDATE ON after_sales_approval_configs, after_sales_cases TO kirindesk_app;
GRANT SELECT, INSERT ON after_sales_approval_config_steps, after_sales_case_approval_steps,
  after_sales_case_decisions, after_sales_adjustments TO kirindesk_app;

REVOKE DELETE ON sample_orders, after_sales_approval_configs, after_sales_cases FROM kirindesk_app;
REVOKE UPDATE, DELETE ON sample_order_items, sample_order_approvals, sample_shipments,
  sample_delivery_confirmations, sample_customer_feedback, sample_order_closures,
  sample_order_conversions, after_sales_approval_config_steps,
  after_sales_case_approval_steps, after_sales_case_decisions,
  after_sales_adjustments FROM kirindesk_app;

-- DOWN
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM sample_orders LIMIT 1)
    OR EXISTS (SELECT 1 FROM after_sales_approval_configs LIMIT 1)
    OR EXISTS (
      SELECT 1 FROM finance_review_items
       WHERE subject_type = 'after_sales_adjustment'
       LIMIT 1
    ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'stage 2F rollback refused: persisted sample or after-sales facts exist',
      HINT = 'Export and migrate the immutable 2F facts through an approved data rollback before retrying schema downgrade.';
  END IF;
END;
$$;

ALTER TABLE finance_review_items DROP CONSTRAINT IF EXISTS chk_finance_review_items_subject;
ALTER TABLE finance_review_items DROP CONSTRAINT IF EXISTS chk_finance_review_items_money;
ALTER TABLE finance_review_items
  ADD CONSTRAINT chk_finance_review_items_subject CHECK (
    subject_type IN (
      'customer_receipt','purchase_cost','order_expense',
      'missing_receipt','missing_cost','missing_freight','missing_fx'
    )
  ),
  ADD CONSTRAINT chk_finance_review_items_money CHECK (
    (
      subject_type IN ('customer_receipt','purchase_cost','order_expense')
      AND subject_id IS NOT NULL AND source_amount IS NOT NULL AND source_amount >= 0
      AND source_currency IS NOT NULL AND fx_rate_to_rmb IS NOT NULL AND fx_rate_to_rmb > 0
      AND fx_source IS NOT NULL AND btrim(fx_source) <> '' AND fx_captured_at IS NOT NULL
      AND amount_rmb IS NOT NULL AND amount_rmb >= 0
    )
    OR
    (
      subject_type IN ('missing_receipt','missing_cost','missing_freight','missing_fx')
      AND subject_id IS NULL AND source_amount IS NULL AND source_currency IS NULL
      AND fx_rate_to_rmb IS NULL AND fx_source IS NULL AND fx_captured_at IS NULL
      AND amount_rmb IS NULL AND decision = 'returned'
    )
  );
DROP TRIGGER IF EXISTS protect_after_sales_case_content_trigger ON after_sales_cases;
DROP TRIGGER IF EXISTS protect_sample_order_content_trigger ON sample_orders;
DROP FUNCTION IF EXISTS protect_after_sales_case_content();
DROP FUNCTION IF EXISTS protect_sample_order_content();
DROP TABLE IF EXISTS after_sales_adjustments CASCADE;
DROP TABLE IF EXISTS after_sales_case_decisions CASCADE;
DROP TABLE IF EXISTS after_sales_case_approval_steps CASCADE;
DROP TABLE IF EXISTS after_sales_cases CASCADE;
DROP TABLE IF EXISTS after_sales_approval_config_steps CASCADE;
DROP TABLE IF EXISTS after_sales_approval_configs CASCADE;
DROP TABLE IF EXISTS sample_order_conversions CASCADE;
ALTER TABLE inquiries DROP CONSTRAINT IF EXISTS uq_inquiries_source_sample_order;
ALTER TABLE inquiries DROP CONSTRAINT IF EXISTS fk_inquiries_source_sample_order;
ALTER TABLE inquiries DROP COLUMN IF EXISTS source_sample_order_id;
DROP TABLE IF EXISTS sample_order_closures CASCADE;
DROP TABLE IF EXISTS sample_customer_feedback CASCADE;
DROP TABLE IF EXISTS sample_delivery_confirmations CASCADE;
DROP TABLE IF EXISTS sample_shipments CASCADE;
DROP TABLE IF EXISTS sample_order_approvals CASCADE;
DROP TABLE IF EXISTS sample_order_items CASCADE;
DROP TABLE IF EXISTS sample_orders CASCADE;
DROP FUNCTION IF EXISTS prevent_stage_2f_append_only_modification();
