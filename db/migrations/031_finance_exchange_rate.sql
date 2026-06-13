-- UP
-- Phase 1F-B: finance / exchange rate.
-- Adds a frozen order-level FX snapshot (rate + source + captured-at + derived
-- base total) to both order tables. total_amount stays in the order's original
-- currency (Phase 1F-A); total_amount_base = round2(total_amount * fx_rate) is
-- derived server-side and frozen on the order so historical value is stable.
--
-- Reuses existing foundation tables (no new tables here):
--   * base currency lives in the existing key-value tenant_settings table
--     (014_tenant_settings.sql) under key = 'base_currency', value_json a JSON
--     scalar string e.g. "RMB". Absent row => default base currency RMB.
--   * exchange rates come from the existing exchange_rates table
--     (019_exchange_rates.sql); the FX provider interface reads it. Not touched
--     by this migration.
-- Both tables already have RLS enabled + tenant_isolation_policy (021), so no
-- RLS or GRANT statements are repeated here.

-- FX snapshot columns on sales_orders. All nullable: drafts and historical
-- header-only orders stay valid until a rate is captured. fx_rate_source
-- allowlist includes 'system' for the same-currency backfill below (rate is
-- definitionally 1, from no external provider). The "same currency => fx_rate
-- = 1" invariant cannot be a table CHECK (it would need to reference the
-- tenant's base currency in another table, which CHECK constraints may not do);
-- it is enforced in the service layer.
ALTER TABLE sales_orders
  ADD COLUMN fx_rate numeric(18,8),
  ADD COLUMN fx_rate_source text,
  ADD COLUMN fx_captured_at timestamptz,
  ADD COLUMN total_amount_base numeric(18,2),
  ADD CONSTRAINT chk_sales_orders_fx_rate CHECK (fx_rate > 0),
  ADD CONSTRAINT chk_sales_orders_fx_rate_source
    CHECK (fx_rate_source IN ('manual','mock','system')),
  ADD CONSTRAINT chk_sales_orders_total_amount_base CHECK (total_amount_base >= 0);

ALTER TABLE purchase_orders
  ADD COLUMN fx_rate numeric(18,8),
  ADD COLUMN fx_rate_source text,
  ADD COLUMN fx_captured_at timestamptz,
  ADD COLUMN total_amount_base numeric(18,2),
  ADD CONSTRAINT chk_purchase_orders_fx_rate CHECK (fx_rate > 0),
  ADD CONSTRAINT chk_purchase_orders_fx_rate_source
    CHECK (fx_rate_source IN ('manual','mock','system')),
  ADD CONSTRAINT chk_purchase_orders_total_amount_base CHECK (total_amount_base >= 0);

-- Backfill: orders already in their tenant's base currency need no conversion,
-- so freeze a trivial rate of 1 and base total = total_amount. The tenant base
-- currency is read from the KV tenant_settings row (key='base_currency'),
-- defaulting to RMB when no row exists. Cross-currency historical orders are
-- left NULL (we do not invent rates that were never transacted).
UPDATE sales_orders so
SET fx_rate = 1,
    fx_rate_source = 'system',
    fx_captured_at = now(),
    total_amount_base = so.total_amount
WHERE so.currency = COALESCE(
  (SELECT ts.value_json #>> '{}' FROM tenant_settings ts
    WHERE ts.tenant_id = so.tenant_id AND ts.key = 'base_currency'),
  'RMB'
);

UPDATE purchase_orders po
SET fx_rate = 1,
    fx_rate_source = 'system',
    fx_captured_at = now(),
    total_amount_base = po.total_amount
WHERE po.currency = COALESCE(
  (SELECT ts.value_json #>> '{}' FROM tenant_settings ts
    WHERE ts.tenant_id = po.tenant_id AND ts.key = 'base_currency'),
  'RMB'
);

-- DOWN
-- Drop the FX columns (constraints drop with them) from both order tables.
-- Foundation tables tenant_settings / exchange_rates are not touched by this
-- migration and are left intact.
ALTER TABLE purchase_orders
  DROP COLUMN IF EXISTS total_amount_base,
  DROP COLUMN IF EXISTS fx_captured_at,
  DROP COLUMN IF EXISTS fx_rate_source,
  DROP COLUMN IF EXISTS fx_rate;

ALTER TABLE sales_orders
  DROP COLUMN IF EXISTS total_amount_base,
  DROP COLUMN IF EXISTS fx_captured_at,
  DROP COLUMN IF EXISTS fx_rate_source,
  DROP COLUMN IF EXISTS fx_rate;
