-- UP

ALTER TABLE purchase_orders
  ADD CONSTRAINT uq_purchase_orders_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE sales_order_items
  ADD CONSTRAINT uq_sales_order_items_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE purchase_order_items
  ADD CONSTRAINT uq_purchase_order_items_tenant_id_id UNIQUE (tenant_id, id);

CREATE TABLE procurement_approval_configs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  version integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  price_variance_threshold_bps integer NOT NULL DEFAULT 500,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_procurement_approval_configs_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_procurement_approval_configs_version UNIQUE (tenant_id, version),
  CONSTRAINT fk_procurement_approval_configs_user
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_procurement_approval_configs_version CHECK (version > 0),
  CONSTRAINT chk_procurement_price_variance_threshold
    CHECK (price_variance_threshold_bps BETWEEN 0 AND 100000)
);

CREATE UNIQUE INDEX uq_procurement_approval_configs_active
  ON procurement_approval_configs (tenant_id) WHERE is_active;

CREATE TABLE procurement_approval_config_steps (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  config_id uuid NOT NULL,
  step_no integer NOT NULL,
  approver_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_procurement_approval_config_steps_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_procurement_approval_config_step UNIQUE (tenant_id, config_id, step_no),
  CONSTRAINT uq_procurement_approval_config_approver
    UNIQUE (tenant_id, config_id, approver_user_id),
  CONSTRAINT fk_procurement_approval_config_step_config
    FOREIGN KEY (tenant_id, config_id)
    REFERENCES procurement_approval_configs(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_approval_config_step_user
    FOREIGN KEY (tenant_id, approver_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_procurement_approval_config_step_no CHECK (step_no > 0)
);

CREATE TABLE procurement_requests (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sales_order_id uuid NOT NULL,
  request_number varchar(64) NOT NULL,
  requested_by uuid NOT NULL,
  approval_config_id uuid NOT NULL,
  approval_config_version integer NOT NULL,
  gate_evaluation_id uuid NOT NULL,
  gate_status varchar(16) NOT NULL,
  price_variance_threshold_bps integer NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'pending_approval',
  note varchar(1000),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_procurement_requests_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_procurement_requests_number UNIQUE (tenant_id, request_number),
  CONSTRAINT fk_procurement_requests_sales_order
    FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_requests_requested_by
    FOREIGN KEY (tenant_id, requested_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_requests_config
    FOREIGN KEY (tenant_id, approval_config_id)
    REFERENCES procurement_approval_configs(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_requests_gate
    FOREIGN KEY (tenant_id, gate_evaluation_id)
    REFERENCES procurement_gate_evaluations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_procurement_requests_gate_status CHECK (gate_status IN ('open', 'bypassed')),
  CONSTRAINT chk_procurement_requests_status
    CHECK (status IN ('pending_approval', 'approved', 'rejected', 'withdrawn')),
  CONSTRAINT chk_procurement_requests_config_version CHECK (approval_config_version > 0),
  CONSTRAINT chk_procurement_requests_price_threshold
    CHECK (price_variance_threshold_bps BETWEEN 0 AND 100000),
  CONSTRAINT chk_procurement_requests_completion CHECK (
    (status = 'pending_approval' AND completed_at IS NULL)
    OR (status <> 'pending_approval' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX idx_procurement_requests_tenant_order
  ON procurement_requests (tenant_id, sales_order_id, created_at DESC);
CREATE INDEX idx_procurement_requests_tenant_status
  ON procurement_requests (tenant_id, status, created_at DESC);
CREATE INDEX idx_procurement_requests_tenant_requester
  ON procurement_requests (tenant_id, requested_by, created_at DESC);

CREATE TABLE procurement_request_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  request_id uuid NOT NULL,
  sales_order_item_id uuid NOT NULL,
  proforma_invoice_item_id uuid NOT NULL,
  selection_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  line_no integer NOT NULL,
  description varchar(500) NOT NULL,
  quantity numeric(18,3) NOT NULL,
  unit varchar(32) NOT NULL,
  currency varchar(3) NOT NULL,
  expected_unit_price numeric(18,4) NOT NULL,
  expected_line_total numeric(18,2) NOT NULL,
  selection_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_procurement_request_items_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_procurement_request_item_line UNIQUE (tenant_id, request_id, line_no),
  CONSTRAINT uq_procurement_request_item_selection UNIQUE (tenant_id, request_id, selection_id),
  CONSTRAINT fk_procurement_request_items_request
    FOREIGN KEY (tenant_id, request_id)
    REFERENCES procurement_requests(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_request_items_sales_item
    FOREIGN KEY (tenant_id, sales_order_item_id)
    REFERENCES sales_order_items(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_request_items_pi_item
    FOREIGN KEY (tenant_id, proforma_invoice_item_id)
    REFERENCES proforma_invoice_items(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_request_items_selection
    FOREIGN KEY (tenant_id, selection_id)
    REFERENCES quote_selection_snapshots(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_request_items_supplier
    FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_procurement_request_items_line_no CHECK (line_no > 0),
  CONSTRAINT chk_procurement_request_items_quantity CHECK (quantity > 0),
  CONSTRAINT chk_procurement_request_items_currency CHECK (currency IN ('RMB','USD','HKD','EUR')),
  CONSTRAINT chk_procurement_request_items_expected_price CHECK (expected_unit_price >= 0),
  CONSTRAINT chk_procurement_request_items_expected_total CHECK (expected_line_total >= 0),
  CONSTRAINT chk_procurement_request_items_snapshot CHECK (jsonb_typeof(selection_snapshot) = 'object')
);

CREATE INDEX idx_procurement_request_items_tenant_request
  ON procurement_request_items (tenant_id, request_id, line_no);
CREATE INDEX idx_procurement_request_items_tenant_selection
  ON procurement_request_items (tenant_id, selection_id);

CREATE TABLE procurement_request_approval_steps (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  request_id uuid NOT NULL,
  config_step_id uuid NOT NULL,
  step_no integer NOT NULL,
  approver_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_procurement_request_approval_steps_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_procurement_request_approval_step UNIQUE (tenant_id, request_id, step_no),
  CONSTRAINT uq_procurement_request_approval_approver
    UNIQUE (tenant_id, request_id, approver_user_id),
  CONSTRAINT fk_procurement_request_approval_steps_request
    FOREIGN KEY (tenant_id, request_id)
    REFERENCES procurement_requests(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_request_approval_steps_config_step
    FOREIGN KEY (tenant_id, config_step_id)
    REFERENCES procurement_approval_config_steps(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_request_approval_steps_user
    FOREIGN KEY (tenant_id, approver_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_procurement_request_approval_steps_step_no CHECK (step_no > 0)
);

CREATE TABLE procurement_request_decisions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  request_id uuid NOT NULL,
  approval_step_id uuid NOT NULL,
  step_no integer NOT NULL,
  decision varchar(16) NOT NULL,
  decided_by uuid NOT NULL,
  reason varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_procurement_request_decisions_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_procurement_request_decision_step UNIQUE (tenant_id, request_id, step_no),
  CONSTRAINT fk_procurement_request_decisions_request
    FOREIGN KEY (tenant_id, request_id)
    REFERENCES procurement_requests(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_request_decisions_step
    FOREIGN KEY (tenant_id, approval_step_id)
    REFERENCES procurement_request_approval_steps(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_request_decisions_user
    FOREIGN KEY (tenant_id, decided_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_procurement_request_decisions_value CHECK (decision IN ('approved', 'rejected')),
  CONSTRAINT chk_procurement_request_decisions_reason CHECK (
    decision <> 'rejected' OR (reason IS NOT NULL AND btrim(reason) <> '')
  )
);

CREATE INDEX idx_procurement_request_decisions_tenant_request
  ON procurement_request_decisions (tenant_id, request_id, step_no);

ALTER TABLE purchase_orders DROP CONSTRAINT chk_purchase_orders_status;
ALTER TABLE purchase_orders
  ADD COLUMN source_procurement_request_id uuid,
  ADD COLUMN expected_total_amount numeric(18,2),
  ADD COLUMN final_total_amount numeric(18,2),
  ADD COLUMN placed_by uuid,
  ADD COLUMN placed_at timestamptz,
  ADD CONSTRAINT fk_purchase_orders_procurement_request
    FOREIGN KEY (tenant_id, source_procurement_request_id)
    REFERENCES procurement_requests(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_purchase_orders_placed_by
    FOREIGN KEY (tenant_id, placed_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_purchase_orders_status CHECK (
    status IN (
      'draft','pending_approval','approved','rejected','confirmed','completed','cancelled',
      'placed','received','closed'
    )
  ),
  ADD CONSTRAINT chk_purchase_orders_expected_total
    CHECK (expected_total_amount IS NULL OR expected_total_amount >= 0),
  ADD CONSTRAINT chk_purchase_orders_final_total
    CHECK (final_total_amount IS NULL OR final_total_amount >= 0),
  ADD CONSTRAINT chk_purchase_orders_placement CHECK (
    (status <> 'placed' AND status <> 'received' AND status <> 'closed')
    OR (source_procurement_request_id IS NOT NULL AND final_total_amount IS NOT NULL
      AND placed_by IS NOT NULL AND placed_at IS NOT NULL)
  );

CREATE INDEX idx_purchase_orders_tenant_procurement_request
  ON purchase_orders (tenant_id, source_procurement_request_id);

CREATE TABLE sales_order_purchase_orders (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sales_order_id uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  procurement_request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sales_order_purchase_orders_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_sales_order_purchase_order UNIQUE (tenant_id, sales_order_id, purchase_order_id),
  CONSTRAINT uq_sales_order_purchase_order_purchase UNIQUE (tenant_id, purchase_order_id),
  CONSTRAINT fk_sales_order_purchase_orders_sales_order
    FOREIGN KEY (tenant_id, sales_order_id)
    REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_order_purchase_orders_purchase_order
    FOREIGN KEY (tenant_id, purchase_order_id)
    REFERENCES purchase_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_order_purchase_orders_request
    FOREIGN KEY (tenant_id, procurement_request_id)
    REFERENCES procurement_requests(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_sales_order_purchase_orders_tenant_sales
  ON sales_order_purchase_orders (tenant_id, sales_order_id, created_at DESC);

ALTER TABLE purchase_order_items
  ADD COLUMN source_procurement_request_item_id uuid,
  ADD COLUMN selection_id uuid,
  ADD COLUMN expected_unit_price numeric(18,4),
  ADD COLUMN final_unit_price numeric(18,4),
  ADD COLUMN expected_line_total numeric(18,2),
  ADD COLUMN final_line_total numeric(18,2),
  ADD COLUMN price_variance_amount numeric(18,2),
  ADD COLUMN price_variance_bps integer,
  ADD COLUMN price_variance_status varchar(24),
  ADD COLUMN price_variance_threshold_bps integer,
  ADD COLUMN pricing_snapshot jsonb,
  ADD COLUMN price_finalized_by uuid,
  ADD COLUMN price_finalized_at timestamptz,
  ADD CONSTRAINT uq_purchase_order_items_request_item
    UNIQUE (tenant_id, source_procurement_request_item_id),
  ADD CONSTRAINT fk_purchase_order_items_request_item
    FOREIGN KEY (tenant_id, source_procurement_request_item_id)
    REFERENCES procurement_request_items(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_purchase_order_items_selection
    FOREIGN KEY (tenant_id, selection_id)
    REFERENCES quote_selection_snapshots(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_purchase_order_items_price_finalizer
    FOREIGN KEY (tenant_id, price_finalized_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_purchase_order_items_expected_unit
    CHECK (expected_unit_price IS NULL OR expected_unit_price >= 0),
  ADD CONSTRAINT chk_purchase_order_items_final_unit
    CHECK (final_unit_price IS NULL OR final_unit_price >= 0),
  ADD CONSTRAINT chk_purchase_order_items_expected_line
    CHECK (expected_line_total IS NULL OR expected_line_total >= 0),
  ADD CONSTRAINT chk_purchase_order_items_final_line
    CHECK (final_line_total IS NULL OR final_line_total >= 0),
  ADD CONSTRAINT chk_purchase_order_items_variance_status
    CHECK (price_variance_status IS NULL OR price_variance_status IN ('within_tolerance','exception')),
  ADD CONSTRAINT chk_purchase_order_items_variance_threshold
    CHECK (price_variance_threshold_bps IS NULL OR price_variance_threshold_bps BETWEEN 0 AND 100000),
  ADD CONSTRAINT chk_purchase_order_items_pricing_snapshot
    CHECK (pricing_snapshot IS NULL OR jsonb_typeof(pricing_snapshot) = 'object'),
  ADD CONSTRAINT chk_purchase_order_items_finalization CHECK (
    (final_unit_price IS NULL AND final_line_total IS NULL AND price_variance_amount IS NULL
      AND price_variance_bps IS NULL AND price_variance_status IS NULL
      AND price_finalized_by IS NULL AND price_finalized_at IS NULL)
    OR
    (final_unit_price IS NOT NULL AND final_line_total IS NOT NULL
      AND price_variance_amount IS NOT NULL AND price_variance_status IS NOT NULL
      AND price_finalized_by IS NOT NULL AND price_finalized_at IS NOT NULL)
  );

CREATE TABLE purchase_price_snapshots (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  purchase_order_id uuid NOT NULL,
  purchase_order_item_id uuid NOT NULL,
  procurement_request_id uuid NOT NULL,
  procurement_request_item_id uuid NOT NULL,
  expected_unit_price numeric(18,4) NOT NULL,
  final_unit_price numeric(18,4) NOT NULL,
  quantity numeric(18,3) NOT NULL,
  expected_line_total numeric(18,2) NOT NULL,
  final_line_total numeric(18,2) NOT NULL,
  variance_amount numeric(18,2) NOT NULL,
  variance_bps integer,
  variance_threshold_bps integer NOT NULL,
  variance_status varchar(24) NOT NULL,
  finalized_by uuid NOT NULL,
  reason varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_purchase_price_snapshots_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_purchase_price_snapshot_item UNIQUE (tenant_id, purchase_order_item_id),
  CONSTRAINT fk_purchase_price_snapshots_order
    FOREIGN KEY (tenant_id, purchase_order_id)
    REFERENCES purchase_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_purchase_price_snapshots_order_item
    FOREIGN KEY (tenant_id, purchase_order_item_id)
    REFERENCES purchase_order_items(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_purchase_price_snapshots_request
    FOREIGN KEY (tenant_id, procurement_request_id)
    REFERENCES procurement_requests(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_purchase_price_snapshots_request_item
    FOREIGN KEY (tenant_id, procurement_request_item_id)
    REFERENCES procurement_request_items(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_purchase_price_snapshots_user
    FOREIGN KEY (tenant_id, finalized_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_purchase_price_snapshots_prices
    CHECK (expected_unit_price >= 0 AND final_unit_price >= 0),
  CONSTRAINT chk_purchase_price_snapshots_quantity CHECK (quantity > 0),
  CONSTRAINT chk_purchase_price_snapshots_totals
    CHECK (expected_line_total >= 0 AND final_line_total >= 0),
  CONSTRAINT chk_purchase_price_snapshots_threshold
    CHECK (variance_threshold_bps BETWEEN 0 AND 100000),
  CONSTRAINT chk_purchase_price_snapshots_status
    CHECK (variance_status IN ('within_tolerance','exception'))
);

CREATE INDEX idx_purchase_price_snapshots_tenant_order
  ON purchase_price_snapshots (tenant_id, purchase_order_id, created_at);

CREATE OR REPLACE FUNCTION prevent_stage_2c_append_only_modification()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION protect_procurement_approval_config()
RETURNS trigger AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.version IS DISTINCT FROM NEW.version
    OR OLD.price_variance_threshold_bps IS DISTINCT FROM NEW.price_variance_threshold_bps
    OR OLD.created_by IS DISTINCT FROM NEW.created_by
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.is_active = false
    OR NEW.is_active = true THEN
    RAISE EXCEPTION 'procurement approval config is immutable except active deactivation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION protect_procurement_request()
RETURNS trigger AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.sales_order_id IS DISTINCT FROM NEW.sales_order_id
    OR OLD.request_number IS DISTINCT FROM NEW.request_number
    OR OLD.requested_by IS DISTINCT FROM NEW.requested_by
    OR OLD.approval_config_id IS DISTINCT FROM NEW.approval_config_id
    OR OLD.approval_config_version IS DISTINCT FROM NEW.approval_config_version
    OR OLD.gate_evaluation_id IS DISTINCT FROM NEW.gate_evaluation_id
    OR OLD.gate_status IS DISTINCT FROM NEW.gate_status
    OR OLD.price_variance_threshold_bps IS DISTINCT FROM NEW.price_variance_threshold_bps
    OR OLD.note IS DISTINCT FROM NEW.note
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'procurement request frozen content is immutable';
  END IF;
  IF NOT (
    OLD.status = 'pending_approval'
    AND NEW.status IN ('approved', 'rejected', 'withdrawn')
  ) THEN
    RAISE EXCEPTION 'invalid procurement request status transition: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION protect_stage_2c_purchase_order()
RETURNS trigger AS $$
BEGIN
  IF OLD.source_procurement_request_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.supplier_id IS DISTINCT FROM NEW.supplier_id
    OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR OLD.order_number IS DISTINCT FROM NEW.order_number
    OR OLD.pi_number IS DISTINCT FROM NEW.pi_number
    OR OLD.pi_file_id IS DISTINCT FROM NEW.pi_file_id
    OR OLD.currency IS DISTINCT FROM NEW.currency
    OR OLD.notes IS DISTINCT FROM NEW.notes
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
    OR OLD.fx_rate IS DISTINCT FROM NEW.fx_rate
    OR OLD.fx_rate_source IS DISTINCT FROM NEW.fx_rate_source
    OR OLD.fx_captured_at IS DISTINCT FROM NEW.fx_captured_at
    OR OLD.total_amount_base IS DISTINCT FROM NEW.total_amount_base
    OR OLD.source_procurement_request_id IS DISTINCT FROM NEW.source_procurement_request_id
    OR OLD.expected_total_amount IS DISTINCT FROM NEW.expected_total_amount THEN
    RAISE EXCEPTION 'generated purchase order frozen content is immutable';
  END IF;
  IF NOT (
    (OLD.status = 'approved' AND NEW.status = 'placed')
    OR (OLD.status = 'placed' AND NEW.status IN ('received', 'closed'))
    OR (OLD.status = 'received' AND NEW.status = 'closed')
  ) THEN
    RAISE EXCEPTION 'invalid generated purchase order status transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status <> 'approved' AND (
    OLD.total_amount IS DISTINCT FROM NEW.total_amount
    OR OLD.final_total_amount IS DISTINCT FROM NEW.final_total_amount
    OR OLD.placed_by IS DISTINCT FROM NEW.placed_by
    OR OLD.placed_at IS DISTINCT FROM NEW.placed_at
  ) THEN
    RAISE EXCEPTION 'generated purchase order placement facts are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION protect_stage_2c_purchase_order_item()
RETURNS trigger AS $$
BEGIN
  IF OLD.source_procurement_request_item_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'generated purchase order items cannot be deleted';
  END IF;
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.order_id IS DISTINCT FROM NEW.order_id
    OR OLD.line_no IS DISTINCT FROM NEW.line_no
    OR OLD.description IS DISTINCT FROM NEW.description
    OR OLD.product_code IS DISTINCT FROM NEW.product_code
    OR OLD.unit IS DISTINCT FROM NEW.unit
    OR OLD.quantity IS DISTINCT FROM NEW.quantity
    OR OLD.unit_price IS DISTINCT FROM NEW.unit_price
    OR OLD.line_total IS DISTINCT FROM NEW.line_total
    OR OLD.notes IS DISTINCT FROM NEW.notes
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
    OR OLD.source_procurement_request_item_id IS DISTINCT FROM NEW.source_procurement_request_item_id
    OR OLD.selection_id IS DISTINCT FROM NEW.selection_id
    OR OLD.expected_unit_price IS DISTINCT FROM NEW.expected_unit_price
    OR OLD.expected_line_total IS DISTINCT FROM NEW.expected_line_total
    OR OLD.price_variance_threshold_bps IS DISTINCT FROM NEW.price_variance_threshold_bps
    OR OLD.pricing_snapshot IS DISTINCT FROM NEW.pricing_snapshot THEN
    RAISE EXCEPTION 'generated purchase order item frozen content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_procurement_approval_config_trigger
  BEFORE UPDATE ON procurement_approval_configs
  FOR EACH ROW EXECUTE FUNCTION protect_procurement_approval_config();
CREATE TRIGGER no_modify_procurement_approval_config_steps
  BEFORE UPDATE OR DELETE ON procurement_approval_config_steps
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2c_append_only_modification();
CREATE TRIGGER protect_procurement_request_trigger
  BEFORE UPDATE ON procurement_requests
  FOR EACH ROW EXECUTE FUNCTION protect_procurement_request();
CREATE TRIGGER no_delete_procurement_requests
  BEFORE DELETE ON procurement_requests
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2c_append_only_modification();
CREATE TRIGGER no_modify_procurement_request_items
  BEFORE UPDATE OR DELETE ON procurement_request_items
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2c_append_only_modification();
CREATE TRIGGER no_modify_procurement_request_approval_steps
  BEFORE UPDATE OR DELETE ON procurement_request_approval_steps
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2c_append_only_modification();
CREATE TRIGGER no_modify_procurement_request_decisions
  BEFORE UPDATE OR DELETE ON procurement_request_decisions
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2c_append_only_modification();
CREATE TRIGGER protect_stage_2c_purchase_order_trigger
  BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION protect_stage_2c_purchase_order();
CREATE TRIGGER no_modify_sales_order_purchase_orders
  BEFORE UPDATE OR DELETE ON sales_order_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2c_append_only_modification();
CREATE TRIGGER protect_stage_2c_purchase_order_item_trigger
  BEFORE UPDATE OR DELETE ON purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION protect_stage_2c_purchase_order_item();
CREATE TRIGGER no_modify_purchase_price_snapshots
  BEFORE UPDATE OR DELETE ON purchase_price_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2c_append_only_modification();

ALTER TABLE procurement_approval_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_approval_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE procurement_approval_config_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_approval_config_steps FORCE ROW LEVEL SECURITY;
ALTER TABLE procurement_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE procurement_request_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_request_items FORCE ROW LEVEL SECURITY;
ALTER TABLE procurement_request_approval_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_request_approval_steps FORCE ROW LEVEL SECURITY;
ALTER TABLE procurement_request_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_request_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_price_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_price_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE sales_order_purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_purchase_orders FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON procurement_approval_configs FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON procurement_approval_config_steps FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON procurement_requests FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON procurement_request_items FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON procurement_request_approval_steps FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON procurement_request_decisions FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON purchase_price_snapshots FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON sales_order_purchase_orders FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON procurement_approval_configs TO kirindesk_app;
GRANT SELECT, INSERT ON procurement_approval_config_steps TO kirindesk_app;
GRANT SELECT, INSERT, UPDATE ON procurement_requests TO kirindesk_app;
GRANT SELECT, INSERT ON procurement_request_items TO kirindesk_app;
GRANT SELECT, INSERT ON procurement_request_approval_steps TO kirindesk_app;
GRANT SELECT, INSERT ON procurement_request_decisions TO kirindesk_app;
GRANT SELECT, INSERT ON purchase_price_snapshots TO kirindesk_app;
GRANT SELECT, INSERT ON sales_order_purchase_orders TO kirindesk_app;

REVOKE DELETE ON procurement_approval_configs FROM kirindesk_app;
REVOKE UPDATE, DELETE ON procurement_approval_config_steps FROM kirindesk_app;
REVOKE DELETE ON procurement_requests FROM kirindesk_app;
REVOKE UPDATE, DELETE ON procurement_request_items FROM kirindesk_app;
REVOKE UPDATE, DELETE ON procurement_request_approval_steps FROM kirindesk_app;
REVOKE UPDATE, DELETE ON procurement_request_decisions FROM kirindesk_app;
REVOKE UPDATE, DELETE ON purchase_price_snapshots FROM kirindesk_app;
REVOKE UPDATE, DELETE ON sales_order_purchase_orders FROM kirindesk_app;

-- DOWN
DROP TRIGGER IF EXISTS no_modify_purchase_price_snapshots ON purchase_price_snapshots;
DROP TRIGGER IF EXISTS no_modify_sales_order_purchase_orders ON sales_order_purchase_orders;
DROP TRIGGER IF EXISTS protect_stage_2c_purchase_order_item_trigger ON purchase_order_items;
DROP TRIGGER IF EXISTS protect_stage_2c_purchase_order_trigger ON purchase_orders;
DROP TRIGGER IF EXISTS no_modify_procurement_request_decisions ON procurement_request_decisions;
DROP TRIGGER IF EXISTS no_modify_procurement_request_approval_steps ON procurement_request_approval_steps;
DROP TRIGGER IF EXISTS no_modify_procurement_request_items ON procurement_request_items;
DROP TRIGGER IF EXISTS no_delete_procurement_requests ON procurement_requests;
DROP TRIGGER IF EXISTS protect_procurement_request_trigger ON procurement_requests;
DROP TRIGGER IF EXISTS no_modify_procurement_approval_config_steps ON procurement_approval_config_steps;
DROP TRIGGER IF EXISTS protect_procurement_approval_config_trigger ON procurement_approval_configs;
DROP FUNCTION IF EXISTS protect_stage_2c_purchase_order_item();
DROP FUNCTION IF EXISTS protect_stage_2c_purchase_order();
DROP FUNCTION IF EXISTS protect_procurement_request();
DROP FUNCTION IF EXISTS protect_procurement_approval_config();
DROP FUNCTION IF EXISTS prevent_stage_2c_append_only_modification();
DROP TABLE IF EXISTS purchase_price_snapshots CASCADE;
DROP TABLE IF EXISTS sales_order_purchase_orders CASCADE;
ALTER TABLE purchase_order_items
  DROP COLUMN IF EXISTS price_finalized_at,
  DROP COLUMN IF EXISTS price_finalized_by,
  DROP COLUMN IF EXISTS pricing_snapshot,
  DROP COLUMN IF EXISTS price_variance_threshold_bps,
  DROP COLUMN IF EXISTS price_variance_status,
  DROP COLUMN IF EXISTS price_variance_bps,
  DROP COLUMN IF EXISTS price_variance_amount,
  DROP COLUMN IF EXISTS final_line_total,
  DROP COLUMN IF EXISTS expected_line_total,
  DROP COLUMN IF EXISTS final_unit_price,
  DROP COLUMN IF EXISTS expected_unit_price,
  DROP COLUMN IF EXISTS selection_id,
  DROP COLUMN IF EXISTS source_procurement_request_item_id;
UPDATE purchase_orders SET status = 'completed' WHERE status IN ('placed', 'received', 'closed');
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS chk_purchase_orders_status;
ALTER TABLE purchase_orders
  DROP COLUMN IF EXISTS placed_at,
  DROP COLUMN IF EXISTS placed_by,
  DROP COLUMN IF EXISTS final_total_amount,
  DROP COLUMN IF EXISTS expected_total_amount,
  DROP COLUMN IF EXISTS source_procurement_request_id,
  ADD CONSTRAINT chk_purchase_orders_status
    CHECK (status IN ('draft','pending_approval','approved','rejected','confirmed','completed','cancelled'));
DROP TABLE IF EXISTS procurement_request_decisions CASCADE;
DROP TABLE IF EXISTS procurement_request_approval_steps CASCADE;
DROP TABLE IF EXISTS procurement_request_items CASCADE;
DROP TABLE IF EXISTS procurement_requests CASCADE;
DROP TABLE IF EXISTS procurement_approval_config_steps CASCADE;
DROP TABLE IF EXISTS procurement_approval_configs CASCADE;
ALTER TABLE purchase_order_items DROP CONSTRAINT IF EXISTS uq_purchase_order_items_tenant_id_id;
ALTER TABLE sales_order_items DROP CONSTRAINT IF EXISTS uq_sales_order_items_tenant_id_id;
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS uq_purchase_orders_tenant_id_id;
