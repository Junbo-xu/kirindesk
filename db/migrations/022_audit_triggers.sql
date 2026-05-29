-- UP
CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs table is append-only: % operations are forbidden', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_modify_audit_logs
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();

-- DOWN
DROP TRIGGER IF EXISTS no_modify_audit_logs ON audit_logs;
DROP FUNCTION IF EXISTS prevent_audit_log_modification();
