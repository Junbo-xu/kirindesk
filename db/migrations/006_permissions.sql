-- UP
CREATE TABLE permissions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  module_id uuid NOT NULL REFERENCES modules(id),
  code varchar(100) NOT NULL UNIQUE,
  name varchar(200) NOT NULL,
  action varchar(20) NOT NULL,
  description varchar(500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_permissions_module_id ON permissions (module_id);
CREATE INDEX idx_permissions_action ON permissions (action);

-- DOWN
DROP TABLE IF EXISTS permissions CASCADE;
