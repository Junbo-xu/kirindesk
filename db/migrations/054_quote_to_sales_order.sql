-- UP
DROP INDEX IF EXISTS idx_sales_orders_tenant_source_quote;
ALTER TABLE sales_orders
  DROP CONSTRAINT IF EXISTS chk_sales_orders_source_quote,
  DROP CONSTRAINT IF EXISTS uq_sales_orders_source_quote_idempotency,
  DROP CONSTRAINT IF EXISTS uq_sales_orders_source_quote,
  DROP CONSTRAINT IF EXISTS fk_sales_orders_source_quote;

ALTER TABLE sales_orders
  RENAME COLUMN source_quote_id TO source_document_set_id;

ALTER TABLE sales_orders
  ALTER COLUMN source_quote_idempotency_key TYPE varchar(128)
    USING source_quote_idempotency_key::text,
  ADD COLUMN source_quote_converted_by uuid,
  ADD COLUMN source_quote_converted_at timestamptz;

UPDATE sales_orders sales_order
   SET source_quote_converted_by = document_set.owner_user_id,
       source_quote_converted_at = COALESCE(
         document_set.locked_at,
         document_set.updated_at,
         document_set.created_at
       )
  FROM trade_document_sets document_set
 WHERE sales_order.tenant_id = document_set.tenant_id
   AND sales_order.source_document_set_id = document_set.id;

ALTER TABLE sales_orders
  ADD CONSTRAINT fk_sales_orders_source_document_set
    FOREIGN KEY (tenant_id, source_document_set_id)
    REFERENCES trade_document_sets(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_sales_orders_source_quote_converter
    FOREIGN KEY (tenant_id, source_quote_converted_by)
    REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_sales_orders_source_quote_version
    CHECK (source_quote_version IS NULL OR source_quote_version > 0),
  ADD CONSTRAINT chk_sales_orders_source_quote_snapshot
    CHECK (source_quote_snapshot IS NULL OR jsonb_typeof(source_quote_snapshot) = 'object'),
  ADD CONSTRAINT chk_sales_orders_source_quote_complete CHECK (
    (source_document_set_id IS NULL
      AND source_quote_number IS NULL
      AND source_quote_version IS NULL
      AND source_quote_snapshot IS NULL
      AND source_quote_idempotency_key IS NULL
      AND source_quote_converted_by IS NULL
      AND source_quote_converted_at IS NULL)
    OR
    (source_document_set_id IS NOT NULL
      AND source_quote_number IS NOT NULL
      AND source_quote_version IS NOT NULL
      AND source_quote_snapshot IS NOT NULL
      AND source_quote_idempotency_key IS NOT NULL
      AND source_quote_converted_by IS NOT NULL
      AND source_quote_converted_at IS NOT NULL)
  );

CREATE UNIQUE INDEX uq_sales_orders_source_document_set
  ON sales_orders (tenant_id, source_document_set_id)
  WHERE source_document_set_id IS NOT NULL;
CREATE UNIQUE INDEX uq_sales_orders_source_quote_idempotency
  ON sales_orders (tenant_id, source_quote_idempotency_key)
  WHERE source_quote_idempotency_key IS NOT NULL;

ALTER TABLE sales_order_items
  ADD COLUMN product_id uuid,
  ADD COLUMN source_document_line_id uuid,
  ADD COLUMN source_line_snapshot jsonb,
  ADD CONSTRAINT fk_sales_order_items_product
    FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_sales_order_items_source_snapshot
    CHECK (source_line_snapshot IS NULL OR jsonb_typeof(source_line_snapshot) = 'object'),
  ADD CONSTRAINT chk_sales_order_items_source_complete CHECK (
    (source_document_line_id IS NULL AND source_line_snapshot IS NULL)
    OR (source_document_line_id IS NOT NULL AND source_line_snapshot IS NOT NULL)
  );

CREATE UNIQUE INDEX uq_sales_order_items_source_document_line
  ON sales_order_items (tenant_id, order_id, source_document_line_id)
  WHERE source_document_line_id IS NOT NULL AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION prevent_sales_order_quote_source_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.source_document_set_id IS NOT NULL AND (
    NEW.source_document_set_id IS DISTINCT FROM OLD.source_document_set_id
    OR NEW.source_quote_number IS DISTINCT FROM OLD.source_quote_number
    OR NEW.source_quote_version IS DISTINCT FROM OLD.source_quote_version
    OR NEW.source_quote_snapshot IS DISTINCT FROM OLD.source_quote_snapshot
    OR NEW.source_quote_idempotency_key IS DISTINCT FROM OLD.source_quote_idempotency_key
    OR NEW.source_quote_converted_by IS DISTINCT FROM OLD.source_quote_converted_by
    OR NEW.source_quote_converted_at IS DISTINCT FROM OLD.source_quote_converted_at
  ) THEN
    RAISE EXCEPTION 'sales order quote source snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_mutate_sales_order_quote_source
  BEFORE UPDATE ON sales_orders
  FOR EACH ROW EXECUTE FUNCTION prevent_sales_order_quote_source_mutation();

CREATE OR REPLACE FUNCTION prevent_locked_trade_document_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'locked' THEN
    IF OLD.sales_order_id IS NULL
       AND NEW.sales_order_id IS NOT NULL
       AND (to_jsonb(NEW) - 'sales_order_id' - 'updated_at')
           = (to_jsonb(OLD) - 'sales_order_id' - 'updated_at') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'locked trade document sets are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- DOWN
CREATE OR REPLACE FUNCTION prevent_locked_trade_document_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'locked' THEN
    RAISE EXCEPTION 'locked trade document sets are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS no_mutate_sales_order_quote_source ON sales_orders;
DROP FUNCTION IF EXISTS prevent_sales_order_quote_source_mutation();

DROP INDEX IF EXISTS uq_sales_order_items_source_document_line;
ALTER TABLE sales_order_items
  DROP CONSTRAINT IF EXISTS chk_sales_order_items_source_complete,
  DROP CONSTRAINT IF EXISTS chk_sales_order_items_source_snapshot,
  DROP CONSTRAINT IF EXISTS fk_sales_order_items_product,
  DROP COLUMN IF EXISTS source_line_snapshot,
  DROP COLUMN IF EXISTS source_document_line_id,
  DROP COLUMN IF EXISTS product_id;

DROP INDEX IF EXISTS uq_sales_orders_source_quote_idempotency;
DROP INDEX IF EXISTS uq_sales_orders_source_document_set;
ALTER TABLE sales_orders
  DROP CONSTRAINT IF EXISTS chk_sales_orders_source_quote_complete,
  DROP CONSTRAINT IF EXISTS chk_sales_orders_source_quote_snapshot,
  DROP CONSTRAINT IF EXISTS chk_sales_orders_source_quote_version,
  DROP CONSTRAINT IF EXISTS fk_sales_orders_source_quote_converter,
  DROP CONSTRAINT IF EXISTS fk_sales_orders_source_document_set,
  DROP COLUMN IF EXISTS source_quote_converted_at,
  DROP COLUMN IF EXISTS source_quote_converted_by;

ALTER TABLE sales_orders
  ALTER COLUMN source_quote_idempotency_key TYPE uuid USING (
    CASE
      WHEN source_quote_idempotency_key IS NULL THEN NULL
      WHEN source_quote_idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN source_quote_idempotency_key::uuid
      ELSE uuid_generate_v5(
        'efd8ecf0-2f53-4d17-bc4c-d869700a7cec'::uuid,
        source_quote_idempotency_key
      )
    END
  );

ALTER TABLE sales_orders
  RENAME COLUMN source_document_set_id TO source_quote_id;

ALTER TABLE sales_orders
  ADD CONSTRAINT fk_sales_orders_source_quote
    FOREIGN KEY (tenant_id, source_quote_id)
    REFERENCES trade_document_sets(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT uq_sales_orders_source_quote UNIQUE (tenant_id, source_quote_id),
  ADD CONSTRAINT uq_sales_orders_source_quote_idempotency
    UNIQUE (tenant_id, source_quote_idempotency_key),
  ADD CONSTRAINT chk_sales_orders_source_quote CHECK (
    (
      source_quote_id IS NULL
      AND source_quote_version IS NULL
      AND source_quote_number IS NULL
      AND source_quote_snapshot IS NULL
      AND source_quote_idempotency_key IS NULL
    )
    OR
    (
      source_quote_id IS NOT NULL
      AND source_quote_version > 0
      AND btrim(source_quote_number) <> ''
      AND jsonb_typeof(source_quote_snapshot) = 'object'
      AND source_quote_idempotency_key IS NOT NULL
    )
  );

CREATE INDEX idx_sales_orders_tenant_source_quote
  ON sales_orders (tenant_id, source_quote_id, created_at DESC)
  WHERE source_quote_id IS NOT NULL;
