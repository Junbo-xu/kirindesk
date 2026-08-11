-- UP
ALTER TABLE sales_orders
  ADD COLUMN source_quote_id uuid,
  ADD COLUMN source_quote_version integer,
  ADD COLUMN source_quote_number varchar(64),
  ADD COLUMN source_quote_snapshot jsonb,
  ADD COLUMN source_quote_idempotency_key uuid,
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

-- DOWN
DROP INDEX IF EXISTS idx_sales_orders_tenant_source_quote;
ALTER TABLE sales_orders
  DROP CONSTRAINT IF EXISTS chk_sales_orders_source_quote,
  DROP CONSTRAINT IF EXISTS uq_sales_orders_source_quote_idempotency,
  DROP CONSTRAINT IF EXISTS uq_sales_orders_source_quote,
  DROP CONSTRAINT IF EXISTS fk_sales_orders_source_quote,
  DROP COLUMN IF EXISTS source_quote_idempotency_key,
  DROP COLUMN IF EXISTS source_quote_snapshot,
  DROP COLUMN IF EXISTS source_quote_number,
  DROP COLUMN IF EXISTS source_quote_version,
  DROP COLUMN IF EXISTS source_quote_id;
