-- 006: al iniciar sesión o validar una sesión aún no hay tenant fijado, y tenants tiene RLS.
-- Esta función devuelve solo el nombre y el estado de un tenant, sin abrir la tabla.

CREATE OR REPLACE FUNCTION auth_tenant(p_tenant_id uuid)
  RETURNS TABLE (name text, status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$ SELECT t.name, t.status FROM tenants t WHERE t.id = p_tenant_id $$;
REVOKE ALL ON FUNCTION auth_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_tenant(uuid) TO zenith_app;
