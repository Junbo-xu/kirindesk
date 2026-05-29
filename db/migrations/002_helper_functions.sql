-- UP
CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS uuid AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_user_id', true), '')::uuid;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION app_current_actor_type()
RETURNS text AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_actor_type', true), '');
END;
$$ LANGUAGE plpgsql STABLE;

-- DOWN
DROP FUNCTION IF EXISTS app_current_actor_type();
DROP FUNCTION IF EXISTS app_current_user_id();
DROP FUNCTION IF EXISTS app_current_tenant_id();
