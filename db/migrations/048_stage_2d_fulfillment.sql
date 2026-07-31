-- UP
-- Stage 2D: partial goods receipts and QC, shipment batches, logistics,
-- immutable expense FX snapshots, delivery proof, and receipt milestones.

ALTER TABLE business_exceptions DROP CONSTRAINT chk_business_exceptions_type;
ALTER TABLE business_exceptions
  ADD CONSTRAINT chk_business_exceptions_type CHECK (
    exception_type IN (
      'price_variance', 'quantity_variance', 'quality_variance',
      'missing_expense', 'duplicate_customer'
    )
  );

CREATE TABLE goods_receipts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sales_order_id uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  batch_number varchar(64) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending',
  qc_result varchar(16),
  is_final_batch boolean NOT NULL DEFAULT false,
  sales_confirmation_required boolean NOT NULL,
  note varchar(1000),
  created_by uuid NOT NULL,
  inspected_by uuid,
  inspected_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_goods_receipts_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_goods_receipts_batch UNIQUE (tenant_id, purchase_order_id, batch_number),
  CONSTRAINT fk_goods_receipts_order_link
    FOREIGN KEY (tenant_id, sales_order_id, purchase_order_id)
    REFERENCES sales_order_purchase_orders(tenant_id, sales_order_id, purchase_order_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_goods_receipts_creator
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_goods_receipts_inspector
    FOREIGN KEY (tenant_id, inspected_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_goods_receipts_status
    CHECK (status IN ('pending', 'inspected', 'accepted', 'rejected')),
  CONSTRAINT chk_goods_receipts_qc_result
    CHECK (qc_result IS NULL OR qc_result IN ('passed', 'partial', 'failed')),
  CONSTRAINT chk_goods_receipts_inspection CHECK (
    (status = 'pending' AND qc_result IS NULL AND inspected_by IS NULL
      AND inspected_at IS NULL AND completed_at IS NULL)
    OR
    (status = 'inspected' AND qc_result IN ('passed', 'partial') AND inspected_by IS NOT NULL
      AND inspected_at IS NOT NULL AND completed_at IS NULL AND sales_confirmation_required)
    OR
    (status IN ('accepted', 'rejected') AND qc_result IS NOT NULL AND inspected_by IS NOT NULL
      AND inspected_at IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX idx_goods_receipts_tenant_purchase
  ON goods_receipts (tenant_id, purchase_order_id, created_at DESC);
CREATE INDEX idx_goods_receipts_tenant_sales
  ON goods_receipts (tenant_id, sales_order_id, status, created_at DESC);

CREATE TABLE goods_receipt_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  goods_receipt_id uuid NOT NULL,
  purchase_order_item_id uuid NOT NULL,
  sales_order_item_id uuid NOT NULL,
  received_quantity numeric(18,3) NOT NULL,
  accepted_quantity numeric(18,3) NOT NULL DEFAULT 0,
  rejected_quantity numeric(18,3) NOT NULL DEFAULT 0,
  quantity_variance numeric(18,3) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_goods_receipt_items_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_goods_receipt_item UNIQUE (tenant_id, goods_receipt_id, purchase_order_item_id),
  CONSTRAINT fk_goods_receipt_items_receipt
    FOREIGN KEY (tenant_id, goods_receipt_id)
    REFERENCES goods_receipts(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_goods_receipt_items_purchase_item
    FOREIGN KEY (tenant_id, purchase_order_item_id)
    REFERENCES purchase_order_items(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_goods_receipt_items_sales_item
    FOREIGN KEY (tenant_id, sales_order_item_id)
    REFERENCES sales_order_items(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_goods_receipt_items_quantities CHECK (
    received_quantity > 0 AND accepted_quantity >= 0 AND rejected_quantity >= 0
      AND accepted_quantity + rejected_quantity <= received_quantity
  )
);

CREATE INDEX idx_goods_receipt_items_tenant_receipt
  ON goods_receipt_items (tenant_id, goods_receipt_id);
CREATE INDEX idx_goods_receipt_items_tenant_purchase_item
  ON goods_receipt_items (tenant_id, purchase_order_item_id);
CREATE INDEX idx_goods_receipt_items_tenant_sales_item
  ON goods_receipt_items (tenant_id, sales_order_item_id);

CREATE TABLE goods_receipt_files (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  goods_receipt_id uuid NOT NULL,
  file_id uuid NOT NULL,
  file_role varchar(20) NOT NULL DEFAULT 'qc_photo',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_goods_receipt_files_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_goods_receipt_file UNIQUE (tenant_id, goods_receipt_id, file_id),
  CONSTRAINT fk_goods_receipt_files_receipt
    FOREIGN KEY (tenant_id, goods_receipt_id)
    REFERENCES goods_receipts(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_goods_receipt_files_file
    FOREIGN KEY (tenant_id, file_id) REFERENCES files(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_goods_receipt_files_role CHECK (file_role IN ('qc_photo', 'document'))
);

CREATE TABLE goods_receipt_confirmations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  goods_receipt_id uuid NOT NULL,
  confirmation_type varchar(24) NOT NULL,
  decision varchar(16) NOT NULL,
  confirmed_by uuid NOT NULL,
  reason varchar(1000),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_goods_receipt_confirmations_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_goods_receipt_confirmation
    UNIQUE (tenant_id, goods_receipt_id, confirmation_type),
  CONSTRAINT fk_goods_receipt_confirmations_receipt
    FOREIGN KEY (tenant_id, goods_receipt_id)
    REFERENCES goods_receipts(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_goods_receipt_confirmations_user
    FOREIGN KEY (tenant_id, confirmed_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_goods_receipt_confirmations_type
    CHECK (confirmation_type IN ('procurement_qc', 'sales_acceptance')),
  CONSTRAINT chk_goods_receipt_confirmations_decision
    CHECK (decision IN ('accepted', 'rejected')),
  CONSTRAINT chk_goods_receipt_confirmations_reason
    CHECK (decision = 'accepted' OR (reason IS NOT NULL AND btrim(reason) <> ''))
);

CREATE TABLE shipments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sales_order_id uuid NOT NULL,
  batch_number varchar(64) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'draft',
  carrier varchar(120) NOT NULL,
  tracking_number varchar(160) NOT NULL,
  created_by uuid NOT NULL,
  dispatched_by uuid,
  dispatched_at timestamptz,
  delivered_by uuid,
  delivered_at timestamptz,
  delivery_proof_file_id uuid,
  delivery_note varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_shipments_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_shipments_batch UNIQUE (tenant_id, sales_order_id, batch_number),
  CONSTRAINT uq_shipments_tracking UNIQUE (tenant_id, carrier, tracking_number),
  CONSTRAINT fk_shipments_sales_order
    FOREIGN KEY (tenant_id, sales_order_id)
    REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_shipments_creator
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_shipments_dispatcher
    FOREIGN KEY (tenant_id, dispatched_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_shipments_deliverer
    FOREIGN KEY (tenant_id, delivered_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_shipments_delivery_proof
    FOREIGN KEY (tenant_id, delivery_proof_file_id)
    REFERENCES files(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_shipments_status CHECK (status IN ('draft', 'dispatched', 'delivered')),
  CONSTRAINT chk_shipments_carrier CHECK (btrim(carrier) <> ''),
  CONSTRAINT chk_shipments_tracking CHECK (btrim(tracking_number) <> ''),
  CONSTRAINT chk_shipments_dispatch CHECK (
    (status = 'draft' AND dispatched_by IS NULL AND dispatched_at IS NULL
      AND delivered_by IS NULL AND delivered_at IS NULL AND delivery_proof_file_id IS NULL)
    OR
    (status = 'dispatched' AND dispatched_by IS NOT NULL AND dispatched_at IS NOT NULL
      AND delivered_by IS NULL AND delivered_at IS NULL AND delivery_proof_file_id IS NULL)
    OR
    (status = 'delivered' AND dispatched_by IS NOT NULL AND dispatched_at IS NOT NULL
      AND delivered_by IS NOT NULL AND delivered_at IS NOT NULL
      AND delivery_proof_file_id IS NOT NULL AND delivered_at >= dispatched_at)
  )
);

CREATE INDEX idx_shipments_tenant_order
  ON shipments (tenant_id, sales_order_id, status, created_at DESC);

CREATE TABLE shipment_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  shipment_id uuid NOT NULL,
  sales_order_item_id uuid NOT NULL,
  quantity numeric(18,3) NOT NULL,
  available_quantity_snapshot numeric(18,3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_shipment_items_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_shipment_item UNIQUE (tenant_id, shipment_id, sales_order_item_id),
  CONSTRAINT fk_shipment_items_shipment
    FOREIGN KEY (tenant_id, shipment_id)
    REFERENCES shipments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_shipment_items_sales_item
    FOREIGN KEY (tenant_id, sales_order_item_id)
    REFERENCES sales_order_items(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_shipment_items_quantity CHECK (
    quantity > 0 AND available_quantity_snapshot >= quantity
  )
);

CREATE INDEX idx_shipment_items_tenant_shipment
  ON shipment_items (tenant_id, shipment_id);
CREATE INDEX idx_shipment_items_tenant_sales_item
  ON shipment_items (tenant_id, sales_order_item_id);

CREATE TABLE logistics_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  shipment_id uuid NOT NULL,
  event_type varchar(24) NOT NULL,
  location varchar(200),
  description varchar(1000),
  occurred_at timestamptz NOT NULL,
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_logistics_events_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT fk_logistics_events_shipment
    FOREIGN KEY (tenant_id, shipment_id)
    REFERENCES shipments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_logistics_events_user
    FOREIGN KEY (tenant_id, recorded_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_logistics_events_type CHECK (
    event_type IN ('dispatched', 'in_transit', 'customs', 'exception', 'delivered')
  )
);

CREATE INDEX idx_logistics_events_tenant_shipment
  ON logistics_events (tenant_id, shipment_id, occurred_at, created_at);

CREATE TABLE order_expenses (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sales_order_id uuid NOT NULL,
  shipment_id uuid,
  expense_type varchar(24) NOT NULL,
  amount numeric(18,4) NOT NULL,
  currency varchar(3) NOT NULL,
  fx_rate_to_rmb numeric(20,8),
  fx_source varchar(120),
  fx_captured_at timestamptz,
  amount_rmb numeric(18,2),
  status varchar(16) NOT NULL,
  note varchar(1000),
  recorded_by uuid NOT NULL,
  completed_by uuid,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_order_expenses_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT fk_order_expenses_sales_order
    FOREIGN KEY (tenant_id, sales_order_id)
    REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_order_expenses_shipment
    FOREIGN KEY (tenant_id, shipment_id)
    REFERENCES shipments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_order_expenses_recorder
    FOREIGN KEY (tenant_id, recorded_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_order_expenses_completer
    FOREIGN KEY (tenant_id, completed_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_order_expenses_type CHECK (
    expense_type IN ('freight', 'insurance', 'customs', 'other')
  ),
  CONSTRAINT chk_order_expenses_amount CHECK (amount > 0),
  CONSTRAINT chk_order_expenses_currency CHECK (currency IN ('RMB', 'USD', 'HKD', 'EUR')),
  CONSTRAINT chk_order_expenses_status CHECK (status IN ('pending_fx', 'complete')),
  CONSTRAINT chk_order_expenses_fx CHECK (
    (status = 'pending_fx' AND currency <> 'RMB' AND fx_rate_to_rmb IS NULL
      AND fx_source IS NULL AND fx_captured_at IS NULL AND amount_rmb IS NULL
      AND completed_by IS NULL AND completed_at IS NULL)
    OR
    (status = 'complete' AND fx_rate_to_rmb > 0 AND fx_source IS NOT NULL
      AND btrim(fx_source) <> '' AND fx_captured_at IS NOT NULL AND amount_rmb >= 0
      AND completed_by IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX idx_order_expenses_tenant_order
  ON order_expenses (tenant_id, sales_order_id, status, created_at DESC);
CREATE INDEX idx_order_expenses_tenant_shipment
  ON order_expenses (tenant_id, shipment_id, created_at DESC);

CREATE TABLE shipment_customer_receipts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  shipment_id uuid NOT NULL,
  customer_receipt_id uuid NOT NULL,
  linked_by uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_shipment_customer_receipts_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_shipment_customer_receipt UNIQUE (tenant_id, customer_receipt_id),
  CONSTRAINT fk_shipment_customer_receipts_shipment
    FOREIGN KEY (tenant_id, shipment_id)
    REFERENCES shipments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_shipment_customer_receipts_receipt
    FOREIGN KEY (tenant_id, customer_receipt_id)
    REFERENCES customer_receipts(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_shipment_customer_receipts_user
    FOREIGN KEY (tenant_id, linked_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION prevent_stage_2d_append_only_modification()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION protect_order_expense_snapshot()
RETURNS trigger AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.sales_order_id IS DISTINCT FROM NEW.sales_order_id
    OR OLD.shipment_id IS DISTINCT FROM NEW.shipment_id
    OR OLD.expense_type IS DISTINCT FROM NEW.expense_type
    OR OLD.amount IS DISTINCT FROM NEW.amount
    OR OLD.currency IS DISTINCT FROM NEW.currency
    OR OLD.note IS DISTINCT FROM NEW.note
    OR OLD.recorded_by IS DISTINCT FROM NEW.recorded_by
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'order expense source facts are immutable';
  END IF;
  IF OLD.status = 'complete' THEN
    RAISE EXCEPTION 'completed order expense FX snapshot is immutable';
  END IF;
  IF NEW.status <> 'complete' THEN
    RAISE EXCEPTION 'pending expense can only transition once to complete';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_modify_goods_receipt_files
  BEFORE UPDATE OR DELETE ON goods_receipt_files
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2d_append_only_modification();
CREATE TRIGGER no_modify_goods_receipt_confirmations
  BEFORE UPDATE OR DELETE ON goods_receipt_confirmations
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2d_append_only_modification();
CREATE TRIGGER no_modify_shipment_items
  BEFORE UPDATE OR DELETE ON shipment_items
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2d_append_only_modification();
CREATE TRIGGER no_modify_logistics_events
  BEFORE UPDATE OR DELETE ON logistics_events
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2d_append_only_modification();
CREATE TRIGGER no_modify_shipment_customer_receipts
  BEFORE UPDATE OR DELETE ON shipment_customer_receipts
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2d_append_only_modification();
CREATE TRIGGER protect_order_expense_snapshot_trigger
  BEFORE UPDATE ON order_expenses
  FOR EACH ROW EXECUTE FUNCTION protect_order_expense_snapshot();
CREATE TRIGGER no_delete_order_expenses
  BEFORE DELETE ON order_expenses
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2d_append_only_modification();

ALTER TABLE goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_items FORCE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_files FORCE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_confirmations FORCE ROW LEVEL SECURITY;
ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments FORCE ROW LEVEL SECURITY;
ALTER TABLE shipment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_items FORCE ROW LEVEL SECURITY;
ALTER TABLE logistics_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_events FORCE ROW LEVEL SECURITY;
ALTER TABLE order_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_expenses FORCE ROW LEVEL SECURITY;
ALTER TABLE shipment_customer_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_customer_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON goods_receipts FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON goods_receipt_items FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON goods_receipt_files FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON goods_receipt_confirmations FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON shipments FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON shipment_items FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON logistics_events FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON order_expenses FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON shipment_customer_receipts FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON goods_receipts TO kirindesk_app;
GRANT SELECT, INSERT, UPDATE ON goods_receipt_items TO kirindesk_app;
GRANT SELECT, INSERT ON goods_receipt_files TO kirindesk_app;
GRANT SELECT, INSERT ON goods_receipt_confirmations TO kirindesk_app;
GRANT SELECT, INSERT, UPDATE ON shipments TO kirindesk_app;
GRANT SELECT, INSERT ON shipment_items TO kirindesk_app;
GRANT SELECT, INSERT ON logistics_events TO kirindesk_app;
GRANT SELECT, INSERT, UPDATE ON order_expenses TO kirindesk_app;
GRANT SELECT, INSERT ON shipment_customer_receipts TO kirindesk_app;

REVOKE DELETE ON goods_receipts, goods_receipt_items, shipments, order_expenses
  FROM kirindesk_app;
REVOKE UPDATE, DELETE ON goods_receipt_files, goods_receipt_confirmations,
  shipment_items, logistics_events, shipment_customer_receipts FROM kirindesk_app;

-- DOWN
DROP TRIGGER IF EXISTS no_delete_order_expenses ON order_expenses;
DROP TRIGGER IF EXISTS protect_order_expense_snapshot_trigger ON order_expenses;
DROP TRIGGER IF EXISTS no_modify_shipment_customer_receipts ON shipment_customer_receipts;
DROP TRIGGER IF EXISTS no_modify_logistics_events ON logistics_events;
DROP TRIGGER IF EXISTS no_modify_shipment_items ON shipment_items;
DROP TRIGGER IF EXISTS no_modify_goods_receipt_confirmations ON goods_receipt_confirmations;
DROP TRIGGER IF EXISTS no_modify_goods_receipt_files ON goods_receipt_files;
DROP FUNCTION IF EXISTS protect_order_expense_snapshot();
DROP FUNCTION IF EXISTS prevent_stage_2d_append_only_modification();
DROP TABLE IF EXISTS shipment_customer_receipts CASCADE;
DROP TABLE IF EXISTS order_expenses CASCADE;
DROP TABLE IF EXISTS logistics_events CASCADE;
DROP TABLE IF EXISTS shipment_items CASCADE;
DROP TABLE IF EXISTS shipments CASCADE;
DROP TABLE IF EXISTS goods_receipt_confirmations CASCADE;
DROP TABLE IF EXISTS goods_receipt_files CASCADE;
DROP TABLE IF EXISTS goods_receipt_items CASCADE;
DROP TABLE IF EXISTS goods_receipts CASCADE;
UPDATE business_exceptions
   SET exception_type = 'quantity_variance'
 WHERE exception_type = 'quality_variance';
ALTER TABLE business_exceptions DROP CONSTRAINT IF EXISTS chk_business_exceptions_type;
ALTER TABLE business_exceptions
  ADD CONSTRAINT chk_business_exceptions_type CHECK (
    exception_type IN ('price_variance', 'quantity_variance', 'missing_expense', 'duplicate_customer')
  );
