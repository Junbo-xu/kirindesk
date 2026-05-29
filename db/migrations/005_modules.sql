-- UP
CREATE TABLE modules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  code varchar(50) NOT NULL UNIQUE,
  name varchar(100) NOT NULL,
  description varchar(500),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_modules_sort_order ON modules (sort_order);

-- DOWN
DROP TABLE IF EXISTS modules CASCADE;
