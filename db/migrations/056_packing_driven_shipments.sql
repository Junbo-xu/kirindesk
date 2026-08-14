-- UP
ALTER TABLE shipments
  DROP CONSTRAINT chk_shipments_status,
  DROP CONSTRAINT chk_shipments_dispatch;

ALTER TABLE shipments
  ADD COLUMN idempotency_key varchar(128),
  ADD COLUMN creation_request jsonb,
  ADD COLUMN packing_list_document_set_id uuid,
  ADD COLUMN packing_list_version integer,
  ADD COLUMN packing_list_snapshot jsonb,
  ADD COLUMN in_transit_by uuid,
  ADD COLUMN in_transit_at timestamptz,
  ADD COLUMN received_by_name varchar(200),
  ADD COLUMN delivery_exception_note varchar(1000),
  ADD CONSTRAINT fk_shipments_packing_list
    FOREIGN KEY (tenant_id, packing_list_document_set_id)
    REFERENCES trade_document_sets(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_shipments_in_transit_user
    FOREIGN KEY (tenant_id, in_transit_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_shipments_creation_request
    CHECK ((idempotency_key IS NULL) = (creation_request IS NULL)),
  ADD CONSTRAINT chk_shipments_packing_source CHECK (
    (packing_list_document_set_id IS NULL
      AND packing_list_version IS NULL
      AND packing_list_snapshot IS NULL)
    OR
    (packing_list_document_set_id IS NOT NULL
      AND packing_list_version > 0
      AND jsonb_typeof(packing_list_snapshot) = 'object')
  ),
  ADD CONSTRAINT chk_shipments_received_by_name
    CHECK (received_by_name IS NULL OR btrim(received_by_name) <> ''),
  ADD CONSTRAINT chk_shipments_status
    CHECK (status IN ('draft', 'dispatched', 'in_transit', 'delivered'));

UPDATE shipments
   SET in_transit_by = delivered_by,
       in_transit_at = dispatched_at
 WHERE status = 'delivered';

ALTER TABLE shipments
  ADD CONSTRAINT chk_shipments_dispatch CHECK (
    (status = 'draft' AND dispatched_by IS NULL AND dispatched_at IS NULL
      AND in_transit_by IS NULL AND in_transit_at IS NULL
      AND delivered_by IS NULL AND delivered_at IS NULL
      AND delivery_proof_file_id IS NULL AND received_by_name IS NULL)
    OR
    (status = 'dispatched' AND dispatched_by IS NOT NULL AND dispatched_at IS NOT NULL
      AND in_transit_by IS NULL AND in_transit_at IS NULL
      AND delivered_by IS NULL AND delivered_at IS NULL
      AND delivery_proof_file_id IS NULL AND received_by_name IS NULL)
    OR
    (status = 'in_transit' AND dispatched_by IS NOT NULL AND dispatched_at IS NOT NULL
      AND in_transit_by IS NOT NULL AND in_transit_at >= dispatched_at
      AND delivered_by IS NULL AND delivered_at IS NULL
      AND delivery_proof_file_id IS NULL AND received_by_name IS NULL)
    OR
    (status = 'delivered' AND dispatched_by IS NOT NULL AND dispatched_at IS NOT NULL
      AND in_transit_by IS NOT NULL AND in_transit_at >= dispatched_at
      AND delivered_by IS NOT NULL AND delivered_at >= in_transit_at
      AND delivery_proof_file_id IS NOT NULL)
  );

CREATE UNIQUE INDEX uq_shipments_idempotency_key
  ON shipments (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE shipment_boxes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  shipment_id uuid NOT NULL,
  package_no varchar(100) NOT NULL,
  gross_weight_kg numeric(18,4) NOT NULL,
  net_weight_kg numeric(18,4) NOT NULL,
  volume_cbm numeric(18,6) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_shipment_boxes_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_shipment_boxes_package UNIQUE (tenant_id, shipment_id, package_no),
  CONSTRAINT fk_shipment_boxes_shipment
    FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_shipment_boxes_package CHECK (btrim(package_no) <> ''),
  CONSTRAINT chk_shipment_boxes_measures CHECK (
    net_weight_kg > 0 AND gross_weight_kg >= net_weight_kg AND volume_cbm > 0
  )
);

CREATE INDEX idx_shipment_boxes_tenant_shipment
  ON shipment_boxes (tenant_id, shipment_id, package_no);

CREATE TABLE shipment_box_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  shipment_box_id uuid NOT NULL,
  sales_order_item_id uuid NOT NULL,
  quantity numeric(18,3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_shipment_box_items_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_shipment_box_item UNIQUE (tenant_id, shipment_box_id, sales_order_item_id),
  CONSTRAINT fk_shipment_box_items_box
    FOREIGN KEY (tenant_id, shipment_box_id)
    REFERENCES shipment_boxes(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_shipment_box_items_sales_item
    FOREIGN KEY (tenant_id, sales_order_item_id)
    REFERENCES sales_order_items(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_shipment_box_items_quantity CHECK (quantity > 0)
);

CREATE INDEX idx_shipment_box_items_tenant_box
  ON shipment_box_items (tenant_id, shipment_box_id);
CREATE INDEX idx_shipment_box_items_tenant_sales_item
  ON shipment_box_items (tenant_id, sales_order_item_id);

CREATE TABLE shipment_delivery_files (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  shipment_id uuid NOT NULL,
  file_id uuid NOT NULL,
  file_role varchar(24) NOT NULL DEFAULT 'delivery_proof',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_shipment_delivery_files_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_shipment_delivery_file UNIQUE (tenant_id, shipment_id, file_id),
  CONSTRAINT fk_shipment_delivery_files_shipment
    FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipments(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_shipment_delivery_files_file
    FOREIGN KEY (tenant_id, file_id) REFERENCES files(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_shipment_delivery_files_role
    CHECK (file_role IN ('delivery_proof', 'exception_evidence'))
);

ALTER TABLE logistics_events
  ADD COLUMN idempotency_key varchar(128),
  ADD COLUMN request_json jsonb,
  ADD CONSTRAINT chk_logistics_events_idempotency
    CHECK ((idempotency_key IS NULL) = (request_json IS NULL));

CREATE UNIQUE INDEX uq_logistics_events_idempotency_key
  ON logistics_events (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TRIGGER no_modify_shipment_boxes
  BEFORE UPDATE OR DELETE ON shipment_boxes
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2d_append_only_modification();
CREATE TRIGGER no_modify_shipment_box_items
  BEFORE UPDATE OR DELETE ON shipment_box_items
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2d_append_only_modification();
CREATE TRIGGER no_modify_shipment_delivery_files
  BEFORE UPDATE OR DELETE ON shipment_delivery_files
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2d_append_only_modification();

ALTER TABLE shipment_boxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_boxes FORCE ROW LEVEL SECURITY;
ALTER TABLE shipment_box_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_box_items FORCE ROW LEVEL SECURITY;
ALTER TABLE shipment_delivery_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_delivery_files FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON shipment_boxes FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON shipment_box_items FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON shipment_delivery_files FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT ON shipment_boxes TO kirindesk_app;
GRANT SELECT, INSERT ON shipment_box_items TO kirindesk_app;
GRANT SELECT, INSERT ON shipment_delivery_files TO kirindesk_app;
REVOKE UPDATE, DELETE ON shipment_boxes, shipment_box_items, shipment_delivery_files
  FROM kirindesk_app;

-- DOWN
DROP INDEX IF EXISTS uq_logistics_events_idempotency_key;
ALTER TABLE logistics_events
  DROP CONSTRAINT IF EXISTS chk_logistics_events_idempotency,
  DROP COLUMN IF EXISTS request_json,
  DROP COLUMN IF EXISTS idempotency_key;

DROP TRIGGER IF EXISTS no_modify_shipment_delivery_files ON shipment_delivery_files;
DROP TRIGGER IF EXISTS no_modify_shipment_box_items ON shipment_box_items;
DROP TRIGGER IF EXISTS no_modify_shipment_boxes ON shipment_boxes;
DROP TABLE IF EXISTS shipment_delivery_files CASCADE;
DROP TABLE IF EXISTS shipment_box_items CASCADE;
DROP TABLE IF EXISTS shipment_boxes CASCADE;

UPDATE shipments
   SET status = 'dispatched'
 WHERE status = 'in_transit';

ALTER TABLE shipments
  DROP CONSTRAINT IF EXISTS chk_shipments_dispatch,
  DROP CONSTRAINT IF EXISTS chk_shipments_status,
  DROP CONSTRAINT IF EXISTS chk_shipments_received_by_name,
  DROP CONSTRAINT IF EXISTS chk_shipments_packing_source,
  DROP CONSTRAINT IF EXISTS chk_shipments_creation_request,
  DROP CONSTRAINT IF EXISTS fk_shipments_in_transit_user,
  DROP CONSTRAINT IF EXISTS fk_shipments_packing_list;
DROP INDEX IF EXISTS uq_shipments_idempotency_key;
ALTER TABLE shipments
  DROP COLUMN IF EXISTS delivery_exception_note,
  DROP COLUMN IF EXISTS received_by_name,
  DROP COLUMN IF EXISTS in_transit_at,
  DROP COLUMN IF EXISTS in_transit_by,
  DROP COLUMN IF EXISTS packing_list_snapshot,
  DROP COLUMN IF EXISTS packing_list_version,
  DROP COLUMN IF EXISTS packing_list_document_set_id,
  DROP COLUMN IF EXISTS creation_request,
  DROP COLUMN IF EXISTS idempotency_key;

ALTER TABLE shipments
  ADD CONSTRAINT chk_shipments_status CHECK (status IN ('draft', 'dispatched', 'delivered')),
  ADD CONSTRAINT chk_shipments_dispatch CHECK (
    (status = 'draft' AND dispatched_by IS NULL AND dispatched_at IS NULL
      AND delivered_by IS NULL AND delivered_at IS NULL AND delivery_proof_file_id IS NULL)
    OR
    (status = 'dispatched' AND dispatched_by IS NOT NULL AND dispatched_at IS NOT NULL
      AND delivered_by IS NULL AND delivered_at IS NULL AND delivery_proof_file_id IS NULL)
    OR
    (status = 'delivered' AND dispatched_by IS NOT NULL AND dispatched_at IS NOT NULL
      AND delivered_by IS NOT NULL AND delivered_at IS NOT NULL
      AND delivery_proof_file_id IS NOT NULL AND delivered_at >= dispatched_at)
  );
