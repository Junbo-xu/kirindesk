-- UP
-- Stage 2E: append-only finance review evidence, immutable profit snapshots,
-- and commission candidate versions connected to final profit.

CREATE TABLE finance_reviews (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sales_order_id uuid NOT NULL,
  version integer NOT NULL,
  decision varchar(16) NOT NULL,
  reason varchar(1000),
  input_fingerprint varchar(64) NOT NULL,
  missing_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewed_by uuid NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_reviews_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_finance_reviews_order_version UNIQUE (tenant_id, sales_order_id, version),
  CONSTRAINT fk_finance_reviews_order
    FOREIGN KEY (tenant_id, sales_order_id)
    REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_reviews_user
    FOREIGN KEY (tenant_id, reviewed_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_finance_reviews_version CHECK (version > 0),
  CONSTRAINT chk_finance_reviews_decision CHECK (decision IN ('verified', 'returned')),
  CONSTRAINT chk_finance_reviews_fingerprint CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_finance_reviews_missing CHECK (jsonb_typeof(missing_items) = 'array'),
  CONSTRAINT chk_finance_reviews_result CHECK (
    (decision = 'verified' AND jsonb_array_length(missing_items) = 0)
    OR
    (decision = 'returned' AND reason IS NOT NULL AND btrim(reason) <> '')
  )
);

CREATE INDEX idx_finance_reviews_tenant_order
  ON finance_reviews (tenant_id, sales_order_id, version DESC);

CREATE TABLE finance_review_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  finance_review_id uuid NOT NULL,
  subject_type varchar(32) NOT NULL,
  subject_id uuid,
  decision varchar(16) NOT NULL,
  reason varchar(1000),
  source_amount numeric(18,4),
  source_currency varchar(3),
  fx_rate_to_rmb numeric(20,8),
  fx_source varchar(120),
  fx_captured_at timestamptz,
  amount_rmb numeric(18,2),
  source_snapshot jsonb NOT NULL,
  reviewed_by uuid NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_review_items_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT fk_finance_review_items_review
    FOREIGN KEY (tenant_id, finance_review_id)
    REFERENCES finance_reviews(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_review_items_user
    FOREIGN KEY (tenant_id, reviewed_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_finance_review_items_subject CHECK (
    subject_type IN (
      'customer_receipt', 'purchase_cost', 'order_expense',
      'missing_receipt', 'missing_cost', 'missing_freight', 'missing_fx'
    )
  ),
  CONSTRAINT chk_finance_review_items_decision CHECK (decision IN ('verified', 'returned')),
  CONSTRAINT chk_finance_review_items_currency
    CHECK (source_currency IS NULL OR source_currency IN ('RMB','USD','HKD','EUR')),
  CONSTRAINT chk_finance_review_items_snapshot CHECK (jsonb_typeof(source_snapshot) = 'object'),
  CONSTRAINT chk_finance_review_items_reason CHECK (
    decision = 'verified' OR (reason IS NOT NULL AND btrim(reason) <> '')
  ),
  CONSTRAINT chk_finance_review_items_money CHECK (
    (
      subject_type IN ('customer_receipt', 'purchase_cost', 'order_expense')
      AND subject_id IS NOT NULL AND source_amount IS NOT NULL AND source_amount >= 0
      AND source_currency IS NOT NULL AND fx_rate_to_rmb IS NOT NULL AND fx_rate_to_rmb > 0
      AND fx_source IS NOT NULL AND btrim(fx_source) <> '' AND fx_captured_at IS NOT NULL
      AND amount_rmb IS NOT NULL AND amount_rmb >= 0
    )
    OR
    (
      subject_type IN ('missing_receipt', 'missing_cost', 'missing_freight', 'missing_fx')
      AND subject_id IS NULL AND source_amount IS NULL AND source_currency IS NULL
      AND fx_rate_to_rmb IS NULL AND fx_source IS NULL AND fx_captured_at IS NULL
      AND amount_rmb IS NULL AND decision = 'returned'
    )
  )
);

CREATE INDEX idx_finance_review_items_tenant_review
  ON finance_review_items (tenant_id, finance_review_id, subject_type, created_at);

CREATE TABLE profit_snapshots (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sales_order_id uuid NOT NULL,
  version integer NOT NULL,
  status varchar(16) NOT NULL,
  supersedes_id uuid,
  finance_review_id uuid,
  formula_version varchar(40) NOT NULL,
  input_fingerprint varchar(64) NOT NULL,
  input_snapshot jsonb NOT NULL,
  missing_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  revenue_rmb numeric(18,2) NOT NULL,
  purchase_cost_rmb numeric(18,2) NOT NULL,
  freight_rmb numeric(18,2) NOT NULL,
  other_expense_rmb numeric(18,2) NOT NULL,
  refund_rmb numeric(18,2) NOT NULL,
  gross_profit_rmb numeric(18,2) NOT NULL,
  net_profit_rmb numeric(18,2) NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_profit_snapshots_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_profit_snapshots_order_version UNIQUE (tenant_id, sales_order_id, version),
  CONSTRAINT fk_profit_snapshots_order
    FOREIGN KEY (tenant_id, sales_order_id)
    REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_profit_snapshots_supersedes
    FOREIGN KEY (tenant_id, supersedes_id)
    REFERENCES profit_snapshots(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_profit_snapshots_review
    FOREIGN KEY (tenant_id, finance_review_id)
    REFERENCES finance_reviews(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_profit_snapshots_user
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_profit_snapshots_version CHECK (version > 0),
  CONSTRAINT chk_profit_snapshots_status CHECK (status IN ('provisional', 'final')),
  CONSTRAINT chk_profit_snapshots_formula CHECK (btrim(formula_version) <> ''),
  CONSTRAINT chk_profit_snapshots_fingerprint CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_profit_snapshots_inputs CHECK (
    jsonb_typeof(input_snapshot) = 'object' AND jsonb_typeof(missing_items) = 'array'
  ),
  CONSTRAINT chk_profit_snapshots_nonnegative_inputs CHECK (
    revenue_rmb >= 0 AND purchase_cost_rmb >= 0 AND freight_rmb >= 0
    AND other_expense_rmb >= 0 AND refund_rmb >= 0
  ),
  CONSTRAINT chk_profit_snapshots_final CHECK (
    (status = 'provisional')
    OR
    (status = 'final' AND finance_review_id IS NOT NULL AND jsonb_array_length(missing_items) = 0)
  ),
  CONSTRAINT chk_profit_snapshots_revision CHECK (
    (version = 1 AND supersedes_id IS NULL) OR (version > 1 AND supersedes_id IS NOT NULL)
  )
);

CREATE INDEX idx_profit_snapshots_tenant_order
  ON profit_snapshots (tenant_id, sales_order_id, version DESC);

CREATE TABLE commission_rule_versions_v2 (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  role_type varchar(16) NOT NULL,
  version integer NOT NULL,
  supersedes_id uuid,
  basis_type varchar(24) NOT NULL,
  rate_bps integer NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_commission_rule_versions_v2_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_commission_rule_versions_v2_role_version UNIQUE (tenant_id, role_type, version),
  CONSTRAINT fk_commission_rule_versions_v2_supersedes
    FOREIGN KEY (tenant_id, supersedes_id)
    REFERENCES commission_rule_versions_v2(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_commission_rule_versions_v2_user
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_commission_rule_versions_v2_role CHECK (role_type IN ('sales','procurement')),
  CONSTRAINT chk_commission_rule_versions_v2_basis
    CHECK (basis_type IN ('sales_revenue','gross_profit','net_profit')),
  CONSTRAINT chk_commission_rule_versions_v2_version CHECK (version > 0),
  CONSTRAINT chk_commission_rule_versions_v2_rate CHECK (rate_bps BETWEEN 0 AND 100000),
  CONSTRAINT chk_commission_rule_versions_v2_revision CHECK (
    (version = 1 AND supersedes_id IS NULL) OR (version > 1 AND supersedes_id IS NOT NULL)
  )
);

CREATE INDEX idx_commission_rule_versions_v2_tenant_role
  ON commission_rule_versions_v2 (tenant_id, role_type, version DESC);

CREATE TABLE commission_candidates_v2 (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sales_order_id uuid NOT NULL,
  profit_snapshot_id uuid NOT NULL,
  version integer NOT NULL,
  supersedes_id uuid,
  formula_version varchar(40) NOT NULL,
  calculation_snapshot jsonb NOT NULL,
  total_commission_rmb numeric(18,2) NOT NULL,
  revision_reason varchar(1000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_commission_candidates_v2_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_commission_candidates_v2_order_version UNIQUE (tenant_id, sales_order_id, version),
  CONSTRAINT fk_commission_candidates_v2_order
    FOREIGN KEY (tenant_id, sales_order_id)
    REFERENCES sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_commission_candidates_v2_profit
    FOREIGN KEY (tenant_id, profit_snapshot_id)
    REFERENCES profit_snapshots(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_commission_candidates_v2_supersedes
    FOREIGN KEY (tenant_id, supersedes_id)
    REFERENCES commission_candidates_v2(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_commission_candidates_v2_user
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_commission_candidates_v2_version CHECK (version > 0),
  CONSTRAINT chk_commission_candidates_v2_formula CHECK (btrim(formula_version) <> ''),
  CONSTRAINT chk_commission_candidates_v2_snapshot
    CHECK (jsonb_typeof(calculation_snapshot) = 'object'),
  CONSTRAINT chk_commission_candidates_v2_total CHECK (total_commission_rmb >= 0),
  CONSTRAINT chk_commission_candidates_v2_revision CHECK (
    (version = 1 AND supersedes_id IS NULL AND revision_reason IS NULL)
    OR
    (version > 1 AND supersedes_id IS NOT NULL AND revision_reason IS NOT NULL
      AND btrim(revision_reason) <> '')
  )
);

CREATE INDEX idx_commission_candidates_v2_tenant_order
  ON commission_candidates_v2 (tenant_id, sales_order_id, version DESC);

CREATE TABLE commission_candidate_lines_v2 (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  candidate_id uuid NOT NULL,
  role_type varchar(16) NOT NULL,
  user_id uuid NOT NULL,
  rule_version_id uuid NOT NULL,
  basis_type varchar(24) NOT NULL,
  raw_basis_rmb numeric(18,2) NOT NULL,
  eligible_basis_rmb numeric(18,2) NOT NULL,
  share_bps integer NOT NULL,
  allocated_basis_rmb numeric(18,2) NOT NULL,
  rate_bps integer NOT NULL,
  commission_amount_rmb numeric(18,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_commission_candidate_lines_v2_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_commission_candidate_lines_v2_person
    UNIQUE (tenant_id, candidate_id, role_type, user_id),
  CONSTRAINT fk_commission_candidate_lines_v2_candidate
    FOREIGN KEY (tenant_id, candidate_id)
    REFERENCES commission_candidates_v2(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_commission_candidate_lines_v2_user
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_commission_candidate_lines_v2_rule
    FOREIGN KEY (tenant_id, rule_version_id)
    REFERENCES commission_rule_versions_v2(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_commission_candidate_lines_v2_role CHECK (role_type IN ('sales','procurement')),
  CONSTRAINT chk_commission_candidate_lines_v2_basis
    CHECK (basis_type IN ('sales_revenue','gross_profit','net_profit')),
  CONSTRAINT chk_commission_candidate_lines_v2_share CHECK (share_bps BETWEEN 1 AND 10000),
  CONSTRAINT chk_commission_candidate_lines_v2_amounts CHECK (
    eligible_basis_rmb >= 0 AND allocated_basis_rmb >= 0
    AND rate_bps BETWEEN 0 AND 100000 AND commission_amount_rmb >= 0
  )
);

CREATE INDEX idx_commission_candidate_lines_v2_candidate
  ON commission_candidate_lines_v2 (tenant_id, candidate_id, role_type);

CREATE TABLE commission_candidate_locks_v2 (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  candidate_id uuid NOT NULL,
  locked_by uuid NOT NULL,
  comment varchar(1000),
  locked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_commission_candidate_locks_v2_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_commission_candidate_locks_v2_candidate UNIQUE (tenant_id, candidate_id),
  CONSTRAINT fk_commission_candidate_locks_v2_candidate
    FOREIGN KEY (tenant_id, candidate_id)
    REFERENCES commission_candidates_v2(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_commission_candidate_locks_v2_user
    FOREIGN KEY (tenant_id, locked_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION prevent_stage_2e_append_only_modification()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_modify_finance_reviews
  BEFORE UPDATE OR DELETE ON finance_reviews
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2e_append_only_modification();
CREATE TRIGGER no_modify_finance_review_items
  BEFORE UPDATE OR DELETE ON finance_review_items
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2e_append_only_modification();
CREATE TRIGGER no_modify_profit_snapshots
  BEFORE UPDATE OR DELETE ON profit_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2e_append_only_modification();
CREATE TRIGGER no_modify_commission_rule_versions_v2
  BEFORE UPDATE OR DELETE ON commission_rule_versions_v2
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2e_append_only_modification();
CREATE TRIGGER no_modify_commission_candidates_v2
  BEFORE UPDATE OR DELETE ON commission_candidates_v2
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2e_append_only_modification();
CREATE TRIGGER no_modify_commission_candidate_lines_v2
  BEFORE UPDATE OR DELETE ON commission_candidate_lines_v2
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2e_append_only_modification();
CREATE TRIGGER no_modify_commission_candidate_locks_v2
  BEFORE UPDATE OR DELETE ON commission_candidate_locks_v2
  FOR EACH ROW EXECUTE FUNCTION prevent_stage_2e_append_only_modification();

ALTER TABLE finance_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE finance_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_review_items FORCE ROW LEVEL SECURITY;
ALTER TABLE profit_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE profit_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE commission_rule_versions_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_rule_versions_v2 FORCE ROW LEVEL SECURITY;
ALTER TABLE commission_candidates_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_candidates_v2 FORCE ROW LEVEL SECURITY;
ALTER TABLE commission_candidate_lines_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_candidate_lines_v2 FORCE ROW LEVEL SECURITY;
ALTER TABLE commission_candidate_locks_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_candidate_locks_v2 FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON finance_reviews FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON finance_review_items FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON profit_snapshots FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON commission_rule_versions_v2 FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON commission_candidates_v2 FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON commission_candidate_lines_v2 FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY tenant_isolation_policy ON commission_candidate_locks_v2 FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT ON finance_reviews, finance_review_items, profit_snapshots,
  commission_rule_versions_v2, commission_candidates_v2,
  commission_candidate_lines_v2, commission_candidate_locks_v2 TO kirindesk_app;
REVOKE UPDATE, DELETE ON finance_reviews, finance_review_items, profit_snapshots,
  commission_rule_versions_v2, commission_candidates_v2,
  commission_candidate_lines_v2, commission_candidate_locks_v2 FROM kirindesk_app;

-- DOWN
DROP TABLE IF EXISTS commission_candidate_locks_v2 CASCADE;
DROP TABLE IF EXISTS commission_candidate_lines_v2 CASCADE;
DROP TABLE IF EXISTS commission_candidates_v2 CASCADE;
DROP TABLE IF EXISTS commission_rule_versions_v2 CASCADE;
DROP TABLE IF EXISTS profit_snapshots CASCADE;
DROP TABLE IF EXISTS finance_review_items CASCADE;
DROP TABLE IF EXISTS finance_reviews CASCADE;
DROP FUNCTION IF EXISTS prevent_stage_2e_append_only_modification();
