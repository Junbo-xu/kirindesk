-- UP
REVOKE UPDATE, DELETE ON audit_logs FROM kirindesk_app;

-- DOWN
GRANT UPDATE, DELETE ON audit_logs TO kirindesk_app;
