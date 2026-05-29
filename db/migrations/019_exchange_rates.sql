-- UP
CREATE TABLE exchange_rates (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  base_currency varchar(3) NOT NULL,
  quote_currency varchar(3) NOT NULL,
  rate decimal(18,8) NOT NULL,
  year_month varchar(7) NOT NULL,
  source varchar(50) NOT NULL DEFAULT 'manual',
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, base_currency, quote_currency, year_month)
);

CREATE INDEX idx_exchange_rates_tenant_id ON exchange_rates (tenant_id);
CREATE INDEX idx_exchange_rates_year_month ON exchange_rates (year_month);

-- DOWN
DROP TABLE IF EXISTS exchange_rates CASCADE;
