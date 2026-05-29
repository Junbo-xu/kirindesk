-- UP
CREATE TABLE plan_modules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  plan_id uuid NOT NULL REFERENCES plans(id),
  module_id uuid NOT NULL REFERENCES modules(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, module_id)
);

CREATE INDEX idx_plan_modules_plan_id ON plan_modules (plan_id);

-- DOWN
DROP TABLE IF EXISTS plan_modules CASCADE;
