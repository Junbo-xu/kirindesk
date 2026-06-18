-- UP
-- Phase 1G AI/OCR: reuse provider_invocations as the AI/OCR task + audit record.
-- No new table (plan §2.1). Two changes:
--   1. (§2.5) add nullable source_file_id linking an OCR/AI invocation to the
--      file it was run over, so "file -> OCR result" is traceable. FK to files
--      with ON DELETE SET NULL: deleting/purging a file must never cascade-delete
--      the invocation audit record — the record outlives its source.
--   2. (§2.4) provider_invocations is append-only (INSERT + SELECT only). The
--      000_app_role default privileges granted all four DML verbs on every new
--      table, so UPDATE/DELETE must be explicitly revoked to enforce immutability
--      at the privilege level (same pattern as audit_logs / commission_settlements).
ALTER TABLE provider_invocations
  ADD COLUMN source_file_id uuid REFERENCES files(id) ON DELETE SET NULL;

REVOKE UPDATE, DELETE ON provider_invocations FROM kirindesk_app;

-- DOWN
-- Restore the pre-1G state: re-grant the DML verbs the 000 default privileges
-- would have given, then drop the added column. Re-granting first keeps the
-- privilege set identical to before this migration; dropping the column does
-- not touch existing data in other columns.
GRANT UPDATE, DELETE ON provider_invocations TO kirindesk_app;

ALTER TABLE provider_invocations
  DROP COLUMN IF EXISTS source_file_id;
