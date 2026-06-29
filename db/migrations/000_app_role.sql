-- UP
-- The app-role password is injected from the APP_DB_PASSWORD env var at migrate
-- time (migrate.ts substituteEnv); never hardcoded. Self-healing: creates the
-- role on a fresh cluster, or converges its password if it already exists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kirindesk_app') THEN
    CREATE ROLE kirindesk_app WITH LOGIN PASSWORD '${APP_DB_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE kirindesk_app WITH LOGIN PASSWORD '${APP_DB_PASSWORD}';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO kirindesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kirindesk_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kirindesk_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kirindesk_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO kirindesk_app;

-- DOWN
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM kirindesk_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM kirindesk_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM kirindesk_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM kirindesk_app;
REVOKE USAGE ON SCHEMA public FROM kirindesk_app;
DROP ROLE IF EXISTS kirindesk_app;
