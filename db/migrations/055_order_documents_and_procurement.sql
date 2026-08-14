-- UP
ALTER TABLE products
  ADD COLUMN supplier_id uuid,
  ADD COLUMN purchase_currency varchar(3),
  ADD COLUMN purchase_unit_price numeric(18,4),
  ADD CONSTRAINT fk_products_supplier
    FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_products_purchase_currency
    CHECK (purchase_currency IS NULL OR purchase_currency IN ('RMB','USD','HKD','EUR')),
  ADD CONSTRAINT chk_products_procurement_mapping CHECK (
    (supplier_id IS NULL AND purchase_currency IS NULL AND purchase_unit_price IS NULL)
    OR
    (supplier_id IS NOT NULL AND purchase_currency IS NOT NULL AND purchase_unit_price > 0)
  );

ALTER TABLE sales_orders
  ADD COLUMN fulfillment_locked_snapshot jsonb,
  ADD COLUMN fulfillment_locked_by uuid,
  ADD COLUMN fulfillment_locked_at timestamptz,
  ADD CONSTRAINT fk_sales_orders_fulfillment_locked_by
    FOREIGN KEY (tenant_id, fulfillment_locked_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_sales_orders_fulfillment_locked_snapshot
    CHECK (fulfillment_locked_snapshot IS NULL OR jsonb_typeof(fulfillment_locked_snapshot) = 'object'),
  ADD CONSTRAINT chk_sales_orders_fulfillment_lock_complete CHECK (
    (fulfillment_locked_snapshot IS NULL
      AND fulfillment_locked_by IS NULL
      AND fulfillment_locked_at IS NULL)
    OR
    (fulfillment_locked_snapshot IS NOT NULL
      AND fulfillment_locked_by IS NOT NULL
      AND fulfillment_locked_at IS NOT NULL)
  );

ALTER TABLE trade_document_sets
  ADD COLUMN source_sales_order_snapshot jsonb,
  ADD COLUMN source_sales_order_updated_at timestamptz,
  ADD COLUMN source_sales_order_locked boolean,
  ADD COLUMN source_sales_order_sync_key varchar(128),
  ADD COLUMN source_sales_order_synced_by uuid,
  ADD COLUMN source_sales_order_synced_at timestamptz,
  ADD CONSTRAINT fk_trade_document_sets_order_sync_user
    FOREIGN KEY (tenant_id, source_sales_order_synced_by)
    REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_trade_document_sets_order_snapshot
    CHECK (source_sales_order_snapshot IS NULL OR jsonb_typeof(source_sales_order_snapshot) = 'object'),
  ADD CONSTRAINT chk_trade_document_sets_order_sync_complete CHECK (
    (source_sales_order_snapshot IS NULL
      AND source_sales_order_updated_at IS NULL
      AND source_sales_order_locked IS NULL
      AND source_sales_order_sync_key IS NULL
      AND source_sales_order_synced_by IS NULL
      AND source_sales_order_synced_at IS NULL)
    OR
    (sales_order_id IS NOT NULL
      AND source_sales_order_snapshot IS NOT NULL
      AND source_sales_order_updated_at IS NOT NULL
      AND source_sales_order_locked IS NOT NULL
      AND source_sales_order_sync_key IS NOT NULL
      AND source_sales_order_synced_by IS NOT NULL
      AND source_sales_order_synced_at IS NOT NULL)
  );

CREATE UNIQUE INDEX uq_trade_document_sets_order_generated
  ON trade_document_sets (tenant_id, sales_order_id)
  WHERE source_sales_order_snapshot IS NOT NULL;
CREATE UNIQUE INDEX uq_trade_document_sets_order_sync_key
  ON trade_document_sets (tenant_id, source_sales_order_sync_key)
  WHERE source_sales_order_sync_key IS NOT NULL;

CREATE TABLE sales_order_document_syncs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sales_order_id uuid NOT NULL,
  document_set_id uuid NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  source_order_updated_at timestamptz NOT NULL,
  source_order_locked boolean NOT NULL,
  result_document_version integer NOT NULL,
  result_document_snapshot jsonb NOT NULL,
  result_refreshed boolean NOT NULL,
  result_preserved_export_count integer NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sales_order_document_syncs_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_sales_order_document_sync_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_sales_order_document_sync_order
    FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_order_document_sync_set
    FOREIGN KEY (tenant_id, document_set_id)
    REFERENCES trade_document_sets(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_order_document_sync_user
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_sales_order_document_sync_version CHECK (result_document_version > 0),
  CONSTRAINT chk_sales_order_document_sync_snapshot
    CHECK (jsonb_typeof(result_document_snapshot) = 'object'),
  CONSTRAINT chk_sales_order_document_sync_export_count
    CHECK (result_preserved_export_count >= 0)
);

CREATE INDEX idx_sales_order_document_syncs_order
  ON sales_order_document_syncs (tenant_id, sales_order_id, created_at DESC);

CREATE TABLE sales_order_purchase_generations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sales_order_id uuid NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  source_order_snapshot jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sales_order_purchase_generations_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_sales_order_purchase_generation_order UNIQUE (tenant_id, sales_order_id),
  CONSTRAINT uq_sales_order_purchase_generation_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_sales_order_purchase_generation_order
    FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_order_purchase_generation_user
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_sales_order_purchase_generation_snapshot
    CHECK (jsonb_typeof(source_order_snapshot) = 'object')
);

CREATE INDEX idx_sales_order_purchase_generations_order
  ON sales_order_purchase_generations (tenant_id, sales_order_id, created_at DESC);

ALTER TABLE purchase_orders
  ADD COLUMN source_sales_order_generation_id uuid,
  ADD CONSTRAINT fk_purchase_orders_sales_order_generation
    FOREIGN KEY (tenant_id, source_sales_order_generation_id)
    REFERENCES sales_order_purchase_generations(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_purchase_orders_single_generation_source CHECK (
    num_nonnulls(source_procurement_request_id, source_sales_order_generation_id) <= 1
  );

CREATE INDEX idx_purchase_orders_sales_order_generation
  ON purchase_orders (tenant_id, source_sales_order_generation_id);

ALTER TABLE purchase_order_items
  ADD COLUMN product_id uuid,
  ADD COLUMN source_sales_order_item_id uuid,
  ADD COLUMN source_sales_order_item_snapshot jsonb,
  ADD CONSTRAINT fk_purchase_order_items_product
    FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_purchase_order_items_sales_order_item
    FOREIGN KEY (tenant_id, source_sales_order_item_id)
    REFERENCES sales_order_items(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_purchase_order_items_sales_source_snapshot
    CHECK (source_sales_order_item_snapshot IS NULL
      OR jsonb_typeof(source_sales_order_item_snapshot) = 'object'),
  ADD CONSTRAINT chk_purchase_order_items_sales_source_complete CHECK (
    (source_sales_order_item_id IS NULL AND source_sales_order_item_snapshot IS NULL)
    OR
    (source_sales_order_item_id IS NOT NULL AND source_sales_order_item_snapshot IS NOT NULL)
  );

CREATE UNIQUE INDEX uq_purchase_order_items_sales_order_item
  ON purchase_order_items (tenant_id, source_sales_order_item_id)
  WHERE source_sales_order_item_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE sales_order_purchase_orders
  ALTER COLUMN procurement_request_id DROP NOT NULL,
  ADD COLUMN source_sales_order_generation_id uuid,
  ADD CONSTRAINT fk_sales_order_purchase_orders_generation
    FOREIGN KEY (tenant_id, source_sales_order_generation_id)
    REFERENCES sales_order_purchase_generations(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_sales_order_purchase_order_source CHECK (
    num_nonnulls(procurement_request_id, source_sales_order_generation_id) = 1
  );

CREATE OR REPLACE FUNCTION protect_fulfillment_locked_sales_order()
RETURNS trigger AS $$
BEGIN
  IF OLD.fulfillment_locked_snapshot IS NOT NULL
    AND (to_jsonb(NEW) - 'status' - 'updated_at')
        IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at') THEN
    RAISE EXCEPTION 'fulfillment-locked sales order facts are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_fulfillment_locked_sales_order_trigger
  BEFORE UPDATE ON sales_orders
  FOR EACH ROW EXECUTE FUNCTION protect_fulfillment_locked_sales_order();

CREATE OR REPLACE FUNCTION protect_fulfillment_locked_sales_order_item()
RETURNS trigger AS $$
DECLARE
  target_order_id uuid;
BEGIN
  target_order_id := COALESCE(NEW.order_id, OLD.order_id);
  IF EXISTS (
    SELECT 1 FROM sales_orders
     WHERE id = target_order_id AND fulfillment_locked_snapshot IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'fulfillment-locked sales order items are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_fulfillment_locked_sales_order_item_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON sales_order_items
  FOR EACH ROW EXECUTE FUNCTION protect_fulfillment_locked_sales_order_item();

CREATE OR REPLACE FUNCTION protect_direct_generated_purchase_order()
RETURNS trigger AS $$
BEGIN
  IF OLD.source_sales_order_generation_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'updated_at')
      IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at') THEN
    RAISE EXCEPTION 'sales-order generated purchase order facts are immutable';
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
    (OLD.status = 'draft' AND NEW.status = 'pending_approval')
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('approved','rejected','draft'))
  ) THEN
    RAISE EXCEPTION 'invalid sales-order generated purchase order status transition: % -> %',
      OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_direct_generated_purchase_order_trigger
  BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION protect_direct_generated_purchase_order();

CREATE OR REPLACE FUNCTION protect_direct_generated_purchase_order_item()
RETURNS trigger AS $$
BEGIN
  IF OLD.source_sales_order_item_id IS NOT NULL THEN
    RAISE EXCEPTION 'sales-order generated purchase order items are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_direct_generated_purchase_order_item_trigger
  BEFORE UPDATE OR DELETE ON purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION protect_direct_generated_purchase_order_item();

ALTER TABLE sales_order_purchase_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_purchase_generations FORCE ROW LEVEL SECURITY;
ALTER TABLE sales_order_document_syncs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_document_syncs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON sales_order_purchase_generations FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON sales_order_document_syncs FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT ON sales_order_purchase_generations TO kirindesk_app;
GRANT SELECT, INSERT ON sales_order_document_syncs TO kirindesk_app;

-- DOWN
DROP TRIGGER IF EXISTS protect_direct_generated_purchase_order_item_trigger
  ON purchase_order_items;
DROP FUNCTION IF EXISTS protect_direct_generated_purchase_order_item();
DROP TRIGGER IF EXISTS protect_direct_generated_purchase_order_trigger ON purchase_orders;
DROP FUNCTION IF EXISTS protect_direct_generated_purchase_order();
DROP TRIGGER IF EXISTS protect_fulfillment_locked_sales_order_item_trigger ON sales_order_items;
DROP FUNCTION IF EXISTS protect_fulfillment_locked_sales_order_item();
DROP TRIGGER IF EXISTS protect_fulfillment_locked_sales_order_trigger ON sales_orders;
DROP FUNCTION IF EXISTS protect_fulfillment_locked_sales_order();

ALTER TABLE sales_order_purchase_orders
  DISABLE TRIGGER no_modify_sales_order_purchase_orders;

DELETE FROM sales_order_purchase_orders
 WHERE source_sales_order_generation_id IS NOT NULL;

ALTER TABLE sales_order_purchase_orders
  ENABLE TRIGGER no_modify_sales_order_purchase_orders;

ALTER TABLE sales_order_purchase_orders
  DROP CONSTRAINT IF EXISTS chk_sales_order_purchase_order_source,
  DROP CONSTRAINT IF EXISTS fk_sales_order_purchase_orders_generation,
  DROP COLUMN IF EXISTS source_sales_order_generation_id,
  ALTER COLUMN procurement_request_id SET NOT NULL;

DROP INDEX IF EXISTS uq_purchase_order_items_sales_order_item;
ALTER TABLE purchase_order_items
  DROP CONSTRAINT IF EXISTS chk_purchase_order_items_sales_source_complete,
  DROP CONSTRAINT IF EXISTS chk_purchase_order_items_sales_source_snapshot,
  DROP CONSTRAINT IF EXISTS fk_purchase_order_items_sales_order_item,
  DROP CONSTRAINT IF EXISTS fk_purchase_order_items_product,
  DROP COLUMN IF EXISTS source_sales_order_item_snapshot,
  DROP COLUMN IF EXISTS source_sales_order_item_id,
  DROP COLUMN IF EXISTS product_id;

DROP INDEX IF EXISTS idx_purchase_orders_sales_order_generation;
ALTER TABLE purchase_orders
  DROP CONSTRAINT IF EXISTS chk_purchase_orders_single_generation_source,
  DROP CONSTRAINT IF EXISTS fk_purchase_orders_sales_order_generation,
  DROP COLUMN IF EXISTS source_sales_order_generation_id;

DROP TABLE IF EXISTS sales_order_purchase_generations CASCADE;

DROP TABLE IF EXISTS sales_order_document_syncs CASCADE;

DROP INDEX IF EXISTS uq_trade_document_sets_order_sync_key;
DROP INDEX IF EXISTS uq_trade_document_sets_order_generated;
ALTER TABLE trade_document_sets
  DROP CONSTRAINT IF EXISTS chk_trade_document_sets_order_sync_complete,
  DROP CONSTRAINT IF EXISTS chk_trade_document_sets_order_snapshot,
  DROP CONSTRAINT IF EXISTS fk_trade_document_sets_order_sync_user,
  DROP COLUMN IF EXISTS source_sales_order_synced_at,
  DROP COLUMN IF EXISTS source_sales_order_synced_by,
  DROP COLUMN IF EXISTS source_sales_order_sync_key,
  DROP COLUMN IF EXISTS source_sales_order_locked,
  DROP COLUMN IF EXISTS source_sales_order_updated_at,
  DROP COLUMN IF EXISTS source_sales_order_snapshot;

ALTER TABLE sales_orders
  DROP CONSTRAINT IF EXISTS chk_sales_orders_fulfillment_lock_complete,
  DROP CONSTRAINT IF EXISTS chk_sales_orders_fulfillment_locked_snapshot,
  DROP CONSTRAINT IF EXISTS fk_sales_orders_fulfillment_locked_by,
  DROP COLUMN IF EXISTS fulfillment_locked_at,
  DROP COLUMN IF EXISTS fulfillment_locked_by,
  DROP COLUMN IF EXISTS fulfillment_locked_snapshot;

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS chk_products_procurement_mapping,
  DROP CONSTRAINT IF EXISTS chk_products_purchase_currency,
  DROP CONSTRAINT IF EXISTS fk_products_supplier,
  DROP COLUMN IF EXISTS purchase_unit_price,
  DROP COLUMN IF EXISTS purchase_currency,
  DROP COLUMN IF EXISTS supplier_id;
